import Specificity from "@bramus/specificity";
import { parse as parseLayerNames } from "@csstools/cascade-layer-name-parser";
import { expand, isShorthand } from "css-shorthand-properties";
import * as csstree from "css-tree";

type SpecificityVal = [i1: number, i2: number, i3: number, i4: number];

/**
 * Represents information about a CSS property declaration.
 */
interface CSSPropertyInfo {
  name: string; // Physical property name after expansion
  value: string;
  important: boolean;
  source: string; // Source of the property (e.g., "inline", "stylesheet.css")
  layerName?: string; // Name of the @layer, if any
  specificity?: SpecificityVal; // Specificity score for sorting
  active: boolean; // True if applied, false if overshadowed
  overshadowedBy?: { ruleSelector: string; layerName?: string }; // Details of overshadowing rule
  inherited: boolean; // True if inherited from an ancestor
  _ruleOrderIndex?: number; // Global order of appearance for tie-breaking
  _ruleOrigin?:
    | "user-agent"
    | "user"
    | "author"
    | "inline"
    | "animation"
    | "transition"; // Rule origin
  originalPropertyName?: string; // Original declared property name
}

/**
 * Represents a parsed CSS rule with metadata.
 */
interface CSSRuleAnalysis {
  selector: string;
  specificity: SpecificityVal;
  properties: CSSPropertyInfo[]; // Properties in this rule
  stylesheetUrl: string;
  layerName?: string; // Name of the @layer, if any
  origin:
    | "user-agent"
    | "user"
    | "author"
    | "inline"
    | "animation"
    | "transition";
  orderIndex: number; // Global order of appearance for tie-breaking
  conditionalContexts: ConditionalContext[]; // Stack of conditional contexts
}

interface ConditionalContext {
  type: "media" | "supports" | "container" | "none";
  condition: string;
  applies: boolean; // Whether the condition is currently met
}

/**
 * Represents the resolved style analysis for an element.
 */
interface ElementStyleAnalysis {
  element: Element;
  computedStyles: CSSStyleDeclaration; // Final computed styles from the browser
  matchingRules: CSSRuleAnalysis[]; // Rules matching the element
  finalProperties: { [key: string]: CSSPropertyInfo }; // Winning properties after cascade
}

interface SheetInfo {
  sheet: CSSStyleSheet;
  href: string | null;
}

// Global map for declared order of layers
const globalLayerOrderMap = new Map<string, number>();
let layerOrderCounter = 0;

// Track processed stylesheets to prevent infinite loops
let processedSheets = new Set<string>();

// prettier-ignore
// Tiny Simple Hash (https://stackoverflow.com/a/52171480/11493659)
const TSH=(s: string)=>{for(var i=0,h=9;i<s.length;)h=Math.imul(h^s.charCodeAt(i++),9**9);return h^h>>>9}

/**
 * Gathers all CSS rules from the document's stylesheets and detached stylesheets,
 * extracting metadata such as specificity, layer information, and conditional contexts.
 *
 * @param detachedSheets - An optional array of detached stylesheets to include in the analysis.
 * @returns A promise resolving to an array of CSSRuleAnalysis objects, representing all parsed CSS rules.
 */
export async function getAllCSSRules(
  detachedSheets: SheetInfo[] = []
): Promise<CSSRuleAnalysis[]> {
  const allRules: CSSRuleAnalysis[] = [];
  processedSheets = new Set<string>();

  /**
   * Recursively processes a stylesheet or grouping rule, extracting rules and metadata.
   */
  async function processCSSRules(
    sheetOrRule: CSSStyleSheet | CSSGroupingRule,
    currentLayerName?: string,
    conditionalStack: ConditionalContext[] = [],
    p: { href: string | null } = { href: null }
  ): Promise<void> {
    // Generate a unique identifier for the current sheet/rule to prevent reprocessing
    const identifier =
      sheetOrRule instanceof CSSStyleSheet && sheetOrRule.href
        ? sheetOrRule.href
        : sheetOrRule instanceof CSSStyleSheet && sheetOrRule.ownerNode
        ? `inline-style-${Math.abs(
            TSH((sheetOrRule.ownerNode as HTMLElement).outerHTML)
          )}` // Unique for inline <style> tags
        : `rule-group-${sheetOrRule.constructor.name}-${crypto.randomUUID()}`; // Fallback for unnamed grouping rules

    if (processedSheets.has(identifier)) {
      return; // Already processed, prevent infinite loop
    }
    processedSheets.add(identifier);

    let rules: CSSRuleList;
    try {
      // Access cssRules, which might throw a security error for cross-origin stylesheets
      if (
        sheetOrRule instanceof CSSStyleSheet ||
        sheetOrRule instanceof CSSMediaRule ||
        sheetOrRule instanceof CSSLayerBlockRule ||
        sheetOrRule instanceof CSSSupportsRule ||
        sheetOrRule instanceof CSSContainerRule
      ) {
        rules = sheetOrRule.cssRules;
      } else {
        console.error("Unsupported rule type", sheetOrRule);
        return;
      }
    } catch (e) {
      console.warn(`Could not access CSS rules for: ${identifier}. Reason:`, e);
      return; // Skip this sheet/rule if access is denied
    }

    // Iterate through each CSSRule within the current sheet or grouping rule
    for (let i = 0; i < rules.length; i++) {
      const cssRule = rules[i];

      // 3.1. Handle `CSSStyleRule` (e.g., `p { color: red; }`):
      if (cssRule instanceof CSSStyleRule) {
        const selector = cssRule.selectorText;
        const specificityScore = calculateSpecificity(selector); // Use @bramus/specificity
        const properties: CSSPropertyInfo[] = []; // This will now store original declared properties

        // Extract the declaration block from cssText (e.g., "{ border-radius: 8px; ... }")
        const declarationBlockTextMatch = cssRule.cssText.match(/{([^}]+)}/);

        if (declarationBlockTextMatch && declarationBlockTextMatch[1]) {
          const declarationBlockText = declarationBlockTextMatch[1]; // Get content inside curly braces

          try {
            // Use css-tree to parse the declaration list
            // The context 'declarationList' is crucial here for parsing just properties and values
            const ast = csstree.parse(declarationBlockText, {
              context: "declarationList",
            });

            // Walk the AST to find individual declarations
            csstree.walk(ast, {
              visit: "Declaration", // We are interested in 'Declaration' nodes
              enter: (node: csstree.Declaration) => {
                const originalName = node.property; // Property name as declared
                const value = csstree.generate(node.value); // Convert AST value to string
                const important = node.important === true; // Check if important flag is set

                properties.push({
                  name: originalName, // Store the original declared property name
                  value,
                  important,
                  active: false,
                  inherited: false,
                  source: cssRule.parentStyleSheet?.href || "inline",
                  layerName: currentLayerName,
                  specificity: specificityScore,
                  originalPropertyName: originalName, // Initially same as name
                });
              },
            });
          } catch (e) {
            console.warn(
              `Error parsing CSSRule.cssText for selector "${selector}":`,
              e
            );
            // If parsing fails for a specific rule, we'll continue, but its properties won't be captured.
          }
        }

        allRules.push({
          selector,
          specificity: specificityScore,
          properties, // This now contains original declared properties
          stylesheetUrl: cssRule.parentStyleSheet?.href || "inline",
          layerName: currentLayerName,
          origin: getOriginFromSheet(cssRule.parentStyleSheet, p.href),
          orderIndex: allRules.length, // Assign a global order index for tie-breaking
          conditionalContexts: [...conditionalStack], // Copy the current stack
        });
      }
      // 3.2. Handle `CSSImportRule` (e.g., `@import "another.css";`):
      else if (cssRule instanceof CSSImportRule) {
        // If the imported stylesheet is accessible (same origin), recursively process it
        if (cssRule.styleSheet) {
          await processCSSRules(
            cssRule.styleSheet,
            currentLayerName,
            conditionalStack,
            p
          );
        }
      }
      // 3.3. Handle `CSSLayerBlockRule` (e.g., `@layer components { ... }`):
      else if (cssRule instanceof CSSLayerBlockRule) {
        // For anonymous (unnamed) layers, we still need to come up with a unique identifier
        // Unnamed layers have an empty string as the .name
        const layerName = cssRule.name || `anonymous-${crypto.randomUUID()}`;
        // Record the layer's declaration order if it's new.
        if (!globalLayerOrderMap.has(layerName)) {
          globalLayerOrderMap.set(layerName, layerOrderCounter++);
        }
        // Recursively process rules inside this named layer block, passing its name
        await processCSSRules(cssRule, layerName, conditionalStack, p);
      }
      // 3.4. Handle `CSSLayerStatementRule` (e.g., `@layer base, components;`):
      else if (cssRule instanceof CSSLayerStatementRule) {
        // Use @csstools/cascade-layer-name-parser to extract all layer names from the statement.
        const layerNames = parseLayerNames(cssRule.nameList.join(", "));
        layerNames.forEach((layer) => {
          const name = layer.name(); // Get the actual string name from the parsed object
          // Record the declaration order for each layer listed in the statement.
          if (!globalLayerOrderMap.has(name)) {
            globalLayerOrderMap.set(name, layerOrderCounter++);
          }
        });
      }
      // 3.5. Handle `CSSMediaRule` (e.g., `@media screen { ... }`):
      else if (cssRule instanceof CSSMediaRule) {
        // Add media query context to the stack
        const mediaContext: ConditionalContext = {
          type: "media",
          condition: cssRule.conditionText || cssRule.media.mediaText,
          applies: evaluateMediaQuery(
            cssRule.conditionText || cssRule.media.mediaText
          ),
        };

        // Recursively process rules within the media block, passing the current layer name
        await processCSSRules(
          cssRule,
          currentLayerName,
          [...conditionalStack, mediaContext], // Add to stack
          p
        );
      }
      // 3.6. Handle other `CSSRule` types if necessary (e.g., CSSSupportsRule, CSSKeyframesRule)
      // For this analysis, we'll primarily focus on style rules and layering.
      else if (cssRule instanceof CSSSupportsRule) {
        // Add supports query context to the stack
        const supportsContext: ConditionalContext = {
          type: "supports",
          condition: cssRule.conditionText,
          applies: evaluateSupportsQuery(cssRule.conditionText),
        };

        await processCSSRules(
          cssRule,
          currentLayerName,
          [...conditionalStack, supportsContext], // Add to stack
          p
        );
      } else if (cssRule instanceof CSSContainerRule) {
        // Add container query context to the stack
        const containerContext: ConditionalContext = {
          type: "container",
          condition: cssRule.containerQuery,
          applies: false, // We don't have the element context evaluate this
        };

        await processCSSRules(
          cssRule,
          currentLayerName,
          [...conditionalStack, containerContext], // Add to stack
          p
        );
      }
    }
  }

  const documentSheets: SheetInfo[] = Array.from(document.styleSheets).map(
    (sheet) => {
      return { sheet, href: sheet.href };
    }
  );

  // Start processing from all document stylesheets
  for (const sheet of [...documentSheets, ...detachedSheets]) {
    await processCSSRules(sheet.sheet, undefined, [], { href: sheet.href });
  }

  return allRules;
}

/**
 * Extracts inline styles from an HTML element and represents them as a synthetic CSS rule.
 *
 * @param element - The HTML element to extract inline styles from.
 * @returns A CSSRuleAnalysis object representing the inline styles, or null if no inline styles exist.
 */
function getInlineStylesForElement(element: Element): CSSRuleAnalysis | null {
  const htmlElement = element as HTMLElement;

  // Check if the element has a style attribute
  if (!htmlElement.style || htmlElement.style.length === 0) {
    return null;
  }

  const properties: CSSPropertyInfo[] = [];

  // Iterate through all inline style properties
  for (let i = 0; i < htmlElement.style.length; i++) {
    const propertyName = htmlElement.style[i];
    const value = htmlElement.style.getPropertyValue(propertyName);
    const priority = htmlElement.style.getPropertyPriority(propertyName);

    properties.push({
      name: propertyName,
      value: value,
      important: priority === "important",
      active: false,
      inherited: false,
      source: "inline",
      originalPropertyName: propertyName,
    });
  }

  // Create a synthetic rule for inline styles
  return {
    conditionalContexts: [],
    selector: "[inline]", // Synthetic selector for debugging/identification
    specificity: [1, 0, 0, 0], // Inline styles have highest specificity
    properties: properties,
    stylesheetUrl: "inline",
    origin: "inline",
    orderIndex: Infinity, // Inline styles appear "last" in document order
  };
}

/**
 * Calculates the specificity of a given CSS selector using the @bramus/specificity library.
 *
 * @param selector - The CSS selector string to calculate specificity for.
 * @returns A SpecificityVal tuple representing the specificity score.
 */
function calculateSpecificity(selector: string): SpecificityVal {
  if (!selector) {
    return [0, 0, 0, 0];
  }
  // @bramus/specificity returns an array of Specificity instances, one for each selector in a list.
  // We expect a single selector here, so we take the first element.
  const specificities = Specificity.calculate(selector);
  if (specificities.length === 0) {
    // Should not happen for valid selectors but as a safeguard
    return [0, 0, 0, 0];
  }
  const s = specificities[0];
  return [0, s.a, s.b, s.c];
}

/**
 * Compares two specificity values to determine if the first is greater than the second.
 *
 * @param spec1 - The first specificity value to compare.
 * @param spec2 - The second specificity value to compare.
 * @returns `true` if `spec1` is greater, `false` if `spec2` is greater, or `null` if they are equal.
 */
function specificityGreater(spec1: SpecificityVal, spec2: SpecificityVal) {
  return spec1.reduce((p, c, i) => {
    if (p === null) {
      if (c > spec2[i]) return true;
      else if (c < spec2[i]) return false;
      // The specificities are equal
      return null;
    } else return p;
  }, null as null | boolean);
}

/**
 * Determines the origin of a stylesheet (e.g., user-agent, user, author, inline).
 *
 * @param sheet - The CSSStyleSheet object or null for inline styles.
 * @param givenHref - An optional href to override the sheet's href.
 * @returns The origin type as a string.
 */
function getOriginFromSheet(
  sheet: CSSStyleSheet | null,
  givenHref: string | null
): "user-agent" | "user" | "author" | "inline" | "animation" | "transition" {
  const href = givenHref ?? sheet?.href ?? null;

  // For direct inline style attributes (element.style), this function is not called.
  // For <style> tags, sheet.href is null, so it falls to 'author' by default.
  if (!sheet) {
    // This case is technically not hit for CSSRuleAnalysis created from CSSOM,
    // as CSSRuleAnalysis is for rules found in sheets/style tags.
    return "inline"; // Represents inline <style> tags, though technically 'author' origin
  }

  // Heuristics for user-agent stylesheets (often have specific prefixes or no href)
  if (href) {
    if (
      href.startsWith("chrome-extension://") ||
      href.startsWith("resource://") ||
      href.startsWith("about:")
    ) {
      return "user-agent";
    }
  }
  return "author";
}

/**
 * Evaluates whether a given media query condition is currently met.
 *
 * @param mediaQuery - The media query string to evaluate.
 * @returns `true` if the media query matches, `false` otherwise.
 */
function evaluateMediaQuery(mediaQuery: string): boolean {
  try {
    return window.matchMedia(mediaQuery).matches;
  } catch (e) {
    console.warn(`Invalid media query: ${mediaQuery}`, e);
    return false; // Conservative approach - don't apply if we can't evaluate
  }
}

/**
 * Evaluates whether a given @supports condition is met.
 *
 * @param supportsQuery - The @supports condition string to evaluate.
 * @returns `true` if the condition is supported, `false` otherwise.
 */
function evaluateSupportsQuery(supportsQuery: string): boolean {
  try {
    // Remove the @supports prefix if present and clean up the query
    const cleanQuery = supportsQuery.replace(/^@supports\s+/i, "").trim();
    return CSS.supports(cleanQuery);
  } catch (e) {
    console.warn(`Invalid @supports query: ${supportsQuery}`, e);
    return false;
  }
}

/**
 * Evaluates whether a container query condition is met for a given element.
 *
 * @param containerQuery - The container query string to evaluate.
 * @param element - The HTML element to evaluate the query against (optional).
 * @returns `true` if the condition is met, `false` otherwise.
 */
function evaluateContainerQuery(
  containerQuery: string,
  element?: Element
): boolean {
  // TODO: Wait for browsers to implement Element.matchContainer()
  //       https://github.com/w3c/csswg-drafts/issues/6205
  //       "[css-contain] Similar to window.matchMedia(), Container Queries should have a similar method"
  console.warn(
    `Container query evaluation not fully implemented: ${containerQuery}`
  );
  return true; // Placeholder - implement based on your needs
}

/**
 * Determines if all conditional contexts in a rule's stack are currently met.
 *
 * @param contexts - An array of ConditionalContext objects representing the rule's conditions.
 * @param element - The HTML element to evaluate the conditions against (optional).
 * @returns `true` if all conditions are met, `false` otherwise.
 */
function areConditionalContextsMet(
  contexts: ConditionalContext[],
  element?: Element
): boolean {
  return contexts.every((context) => {
    switch (context.type) {
      case "media":
        return evaluateMediaQuery(context.condition);
      case "supports":
        return evaluateSupportsQuery(context.condition);
      case "container":
        return evaluateContainerQuery(context.condition, element);
      case "none":
        return true;
      default:
        return false;
    }
  });
}

/**
 * Filters the global list of CSS rules to find those that match a given HTML element.
 *
 * @param element - The HTML element to match rules against.
 * @param allRules - The comprehensive list of all parsed CSS rules.
 * @returns An array of CSSRuleAnalysis objects that match the element.
 */
function getMatchingRulesForElement(
  element: Element,
  allRules: CSSRuleAnalysis[]
): CSSRuleAnalysis[] {
  return allRules.filter((rule) => {
    try {
      // First check if the selector matches
      if (!element.matches(rule.selector)) {
        return false;
      }

      // Then check if all conditional contexts are met
      return areConditionalContextsMet(rule.conditionalContexts, element);
    } catch (e) {
      // Handle invalid selectors gracefully, e.g., log error to console
      console.warn(
        `Skipping rule with invalid selector "${rule.selector}" for element`,
        element,
        ". Error:",
        e
      );
      return false;
    }
  });
}

/**
 * Resolves the final styles for an HTML element by applying the CSS cascade algorithm.
 *
 * @param element - The HTML element to analyze.
 * @param allRules - The comprehensive list of all parsed CSS rules.
 * @returns An ElementStyleAnalysis object containing the resolved styles and cascade details.
 */
export function resolveCascadeForElement(
  element: Element,
  allRules: CSSRuleAnalysis[]
): ElementStyleAnalysis {
  const matchingRules = getMatchingRulesForElement(element, allRules);

  const inlineStyles = getInlineStylesForElement(element);
  if (inlineStyles) matchingRules.push(inlineStyles);

  const finalProperties: { [key: string]: CSSPropertyInfo } = {};
  const propertiesToConsider: { [key: string]: CSSPropertyInfo[] } = {};

  matchingRules.forEach((rule) => {
    rule.properties.forEach((prop) => {
      // NEW LOGIC: Expand property here with element context
      // 'prop' here still holds the original declared property name (e.g., 'margin')
      const expandedProps = expandProperty(prop, element); // Call the new expansion function

      expandedProps.forEach((expandedProp) => {
        // Ensure all necessary internal cascade properties are carried over or set
        // These properties are part of the original 'rule' or 'prop' itself,
        // and must be copied to the new 'expandedProp' for correct sorting.
        if (!propertiesToConsider[expandedProp.name]) {
          propertiesToConsider[expandedProp.name] = [];
        }
        propertiesToConsider[expandedProp.name].push({
          ...expandedProp, // Includes name (physical), value, important, originalPropertyName etc.
          _ruleOrderIndex: rule.orderIndex, // From the parent rule
          _ruleOrigin: rule.origin, // From the parent rule
          specificity: rule.specificity, // From the parent rule
        });
      });
    });
  });

  /**
   * Calculates a numerical score representing the precedence of a CSS declaration
   * based on its origin, importance, and cascade layer. Higher score means higher precedence.
   * This function implements the complex hierarchy of the CSS cascade.
   *
   * @param prop The CSSPropertyInfo object for the declaration.
   * @returns A numerical score for cascade comparison.
   */
  const getCascadeScore = (prop: CSSPropertyInfo) => {
    const origin = prop._ruleOrigin!;
    const isImportant = prop.important;
    const layerOrder = prop.layerName
      ? globalLayerOrderMap.get(prop.layerName)
      : undefined;
    const isLayered = layerOrder !== undefined;
    const totalLayers = globalLayerOrderMap.size; // Total number of layers discovered

    const INC = totalLayers + 1;
    let score = 0; // Base score for this declaration

    // Step 1: Handle Transitions (absolute highest and lowest in the cascade)
    if (origin === "transition") {
      return isImportant ? Infinity : -Infinity; // Transitions are always highest !important or lowest normal
    }

    // Step 2: Handle !important declarations (high precedence group)
    if (isImportant) {
      // Order from highest !important to lowest !important (excluding transitions):
      // User-agent > User > Inline > Author (layered: earlier declared wins) > Author (unlayered) > Animation
      if (origin === "user-agent") score = INC * 11;
      else if (origin === "user") score = INC * 10;
      else if (origin === "inline")
        score = INC * 9; // Inline `style` attribute (!important)
      else if (origin === "author") {
        // Author !important rules have a base score, then adjusted by layer.
        // Earlier declared layers win for !important.
        score = INC * 8; // Base score for author !important
        if (isLayered) {
          // For !important, smaller layerOrder (earlier declared) gets a higher score.
          // If layerOrder is 0 (first declared), it gets the max bonus (totalLayers - 0).
          score += totalLayers - (layerOrder || 0); // (layerOrder || 0) handles undefined safely
        } else {
          // Unlayered !important author declarations are *lower* than any layered !important author rules.
          // Giving them a score equal to the base without layer bonus ensures this.
          score += 0;
        }
      } else if (origin === "animation") score = INC * 7; // Animation !important is weakest among important declarations.
    }
    // Step 3: Handle Normal declarations (lower precedence group)
    else {
      // Order from highest normal to lowest normal (excluding transitions):
      // Animation > Inline > Author (unlayered) > Author (layered: later declared wins) > User > User-agent
      if (origin === "animation") score = INC * 6;
      // Animation normal is highest among normal declarations.
      else if (origin === "inline")
        score = INC * 5; // Inline `style` attribute (normal)
      else if (origin === "author") {
        // Author normal rules have a base score, then adjusted by layer.
        // Unlayered author normal declarations are *higher* than any layered author normal rules.
        // Later declared layers win for normal rules.
        score = INC * 3; // Base score for author normal
        if (isLayered) {
          // For normal, larger layerOrder (later declared) gets a higher score.
          score += layerOrder || 0;
        } else {
          // Unlayered normal author is *stronger* than any layered normal author.
          // Giving it a score higher than the max possible layered score ensures this.
          score += INC;
        }
      } else if (origin === "user") score = INC * 2;
      else if (origin === "user-agent") score = INC * 1;
    }
    return score;
  };

  // For each property, apply the cascade algorithm to determine the winning declaration
  for (const propName in propertiesToConsider) {
    const declarations = propertiesToConsider[propName];

    // Sort declarations based on the W3C Cascade Algorithm
    declarations.sort((a, b) => {
      // 1. Origin and Importance precedence (handled by getCascadeScore)
      const scoreA = getCascadeScore(a);
      const scoreB = getCascadeScore(b);

      if (scoreA !== scoreB) {
        return scoreB - scoreA; // Higher score wins
      }

      // 2. Specificity (A-B-C) - only if origin/importance/layer are equal
      if (a.specificity && b.specificity) {
        const isAGreater = specificityGreater(a.specificity, b.specificity);
        if (isAGreater !== null) return isAGreater ? -1 : 1;
      }

      // 3. Order of Appearance (final tie-breaker if all else is equal)
      return b._ruleOrderIndex! - a._ruleOrderIndex!; // Later declared rule wins
    });

    if (declarations.length > 0) {
      const winningDeclaration = declarations[0];
      // Store the winning declaration in finalProperties
      finalProperties[propName] = {
        ...winningDeclaration,
        active: true,
      };

      // Mark overshadowed properties
      for (let i = 1; i < declarations.length; i++) {
        declarations[i].active = false;
        declarations[i].overshadowedBy = {
          // Use originalPropertyName for better context on overshadowed properties
          ruleSelector:
            declarations[i].originalPropertyName || declarations[i].name,
          layerName: declarations[i].layerName,
        };
      }
    }
  }

  // (Post-cascade) Determine inherited properties
  const computedBrowserStyles = window.getComputedStyle(element);

  for (let i = 0; i < computedBrowserStyles.length; i++) {
    const propName = computedBrowserStyles[i];
    // If our cascade logic didn't find a winning rule for this property
    // AND it's an inheritable property AND its value is not the 'initial' or 'unset' state
    if (
      !finalProperties[propName] &&
      isInheritableProperty(propName) &&
      computedBrowserStyles.getPropertyValue(propName) !== "initial" &&
      computedBrowserStyles.getPropertyValue(propName) !== "unset"
    ) {
      // Check if the property value is inherited from an ancestor
      let currentElement: Element | null = element.parentElement;
      while (currentElement) {
        const parentComputedStyle = window.getComputedStyle(currentElement);
        const inheritedValue = parentComputedStyle.getPropertyValue(propName);
        if (
          inheritedValue &&
          inheritedValue !== "initial" &&
          inheritedValue !== "unset"
        ) {
          // This is a basic check; a more robust solution might compare against initial values
          // or traverse the cascade for the parent. For now, matching the browser's computed style.
          if (
            inheritedValue === computedBrowserStyles.getPropertyValue(propName)
          ) {
            finalProperties[propName] = {
              name: propName,
              value: inheritedValue,
              important: false, // Inherited values are never !important from source rules
              source: `inherited from ancestor`,
              active: true,
              inherited: true,
            };
            break; // Stop at the first ancestor providing a value
          }
        }
        currentElement = currentElement.parentElement;
      }
    }
  }

  // Helper to determine if a property is generally inheritable (simplified list)
  function isInheritableProperty(prop: string): boolean {
    // prettier-ignore
    const inheritableProps = ["azimuth", "border-collapse", "border-spacing", "caption-side", "color", "cursor", "direction",
                              "empty-cells", "font-family", "font-size", "font-style", "font-variant", "font-weight", "font",
                              "letter-spacing", "line-height", "list-style-image", "list-style-position", "list-style-type",
                              "list-style", "orphans", "quotes", "tab-size", "text-align", "text-indent", "text-transform",
                              "visibility", "white-space", "widows", "word-break", "word-spacing", "word-wrap"];
    return inheritableProps.includes(prop);
  }

  // Update the original matchingRules with the `active` status based on `finalProperties`
  const updatedMatchingRules = matchingRules.map((rule) => {
    const updatedProperties = rule.properties.map((prop) => {
      // Find match of originalPropertyName in finalProperties with original properties
      const propNameMatch = Object.entries(finalProperties).find(
        ([, { originalPropertyName }]) => originalPropertyName === prop.name
      );
      const finalProp = propNameMatch
        ? finalProperties[propNameMatch[1].name]
        : null;

      // Check if this specific property declaration (from this rule) is the one that won
      // Compare all key identifiers to ensure it's the exact declaration instance
      if (
        finalProp &&
        finalProp.value === prop.value &&
        finalProp.important === prop.important &&
        finalProp.source === prop.source &&
        finalProp.layerName === prop.layerName &&
        finalProp._ruleOrderIndex === rule.orderIndex && // Compare ruleOrderIndex, which is the closest thing to an ID we have
        prop.specificity?.[0] === finalProp.specificity?.[0] && // Compare specificity components too
        prop.specificity?.[1] === finalProp.specificity?.[1] &&
        prop.specificity?.[2] === finalProp.specificity?.[2] &&
        prop.specificity?.[3] === finalProp.specificity?.[3] &&
        prop.originalPropertyName === finalProp.originalPropertyName // Compare original property name
        // (note we do not compare .name, which is mapped to a physical property in finalProperties)
      ) {
        return { ...prop, active: true };
      } else {
        return {
          ...prop,
          active: false,
          overshadowedBy: finalProp
            ? {
                ruleSelector: rule.selector,
                layerName: finalProp.layerName,
              }
            : undefined,
        };
      }
    });
    return { ...rule, properties: updatedProperties };
  });

  return {
    element,
    computedStyles: computedBrowserStyles,
    matchingRules: updatedMatchingRules,
    finalProperties,
  };
}

// The list was automatically generated by going to https://www.w3.org/TR/2018/WD-css-logical-1-20180827/
//  and running the following commented-out code.

// // Get all the property definitions,
// // go to the <p> tag that follows the table,
// // and find all property definitions in the first sentence (before the first period).

// const propdefs = document.querySelectorAll('[id^="propdef-"]');
// const getFollowingP = (el: Element) =>
//   el.parentElement?.parentElement?.parentElement?.parentElement
//     ?.nextElementSibling;
// Array(...propdefs).map((propdef) => [
//   propdef.id.slice("propdef-".length),
//   Array(...getFollowingP(propdef)!.querySelectorAll('[href*="#propdef-"]'))
//     .filter(
//       (el) =>
//         getFollowingP(propdef)!.textContent!.indexOf(el.textContent!) <
//         getFollowingP(propdef)!.textContent!.indexOf("."),
//     )
//     .map((el) => el.textContent),
// ]);

type LogicalPropsMaps = [name: string, props: string[]][];
// prettier-ignore
const logicalPropsMaps_: LogicalPropsMaps = [
  ["block-size", ["width", "height"]],
  ["inline-size", ["width", "height"]],
  ["min-block-size", ["min-width", "min-height"]],
  ["min-inline-size", ["min-width", "min-height"]],
  ["max-block-size", ["max-width", "max-height"]],
  ["max-inline-size", ["max-width", "max-height"]],
  ["margin-block-start", ["margin-top", "margin-bottom", "margin-left", "margin-right"]],
  ["margin-block-end", ["margin-top", "margin-bottom", "margin-left", "margin-right"]],
  ["margin-inline-start", ["margin-top", "margin-bottom", "margin-left", "margin-right"]],
  ["margin-inline-end", ["margin-top", "margin-bottom", "margin-left", "margin-right"]],
  ["margin-block", ["margin-block-start", "margin-block-end"]],
  ["margin-inline", ["margin-inline-start", "margin-inline-end"]],
  ["inset-block-start", ["top", "bottom", "left", "right"]],
  ["inset-block-end", ["top", "bottom", "left", "right"]],
  ["inset-inline-start", ["top", "bottom", "left", "right"]],
  ["inset-inline-end", ["top", "bottom", "left", "right"]],
  ["inset-block", ["inset-block-start", "inset-block-end"]],
  ["inset-inline", ["inset-inline-start", "inset-inline-end"]],
  ["inset", ["top", "right", "bottom", "left"]],
  ["padding-block-start", ["padding-top", "padding-bottom", "padding-left", "padding-right"]],
  ["padding-block-end", ["padding-top", "padding-bottom", "padding-left", "padding-right"]],
  ["padding-inline-start", ["padding-top", "padding-bottom", "padding-left", "padding-right"]],
  ["padding-inline-end", ["padding-top", "padding-bottom", "padding-left", "padding-right"]],
  ["padding-block", ["padding-block-start", "padding-block-end"]],
  ["padding-inline", ["padding-inline-start", "padding-inline-end"]],
  ["border-block-start-width", ["border-top-width", "border-bottom-width", "border-left-width", "border-right-width"]],
  ["border-block-end-width", ["border-top-width", "border-bottom-width", "border-left-width", "border-right-width"]],
  ["border-inline-start-width", ["border-top-width", "border-bottom-width", "border-left-width", "border-right-width"]],
  ["border-inline-end-width", ["border-top-width", "border-bottom-width", "border-left-width", "border-right-width"]],
  ["border-block-width", ["border-block-start-width", "border-block-end-width"]],
  ["border-inline-width", ["border-inline-start-width", "border-inline-end-width"]],
  ["border-block-start-style", ["border-top-style", "border-bottom-style", "border-left-style", "border-right-style"]],
  ["border-block-end-style", ["border-top-style", "border-bottom-style", "border-left-style", "border-right-style"]],
  ["border-inline-start-style", ["border-top-style", "border-bottom-style", "border-left-style", "border-right-style"]],
  ["border-inline-end-style", ["border-top-style", "border-bottom-style", "border-left-style", "border-right-style"]],
  ["border-block-style", ["border-block-start-style", "border-block-end-style"]],
  ["border-inline-style", ["border-inline-start-style", "border-inline-end-style"]],
  ["border-block-start-color", ["border-top-color", "border-bottom-color", "border-left-color", "border-right-color"]],
  ["border-block-end-color", ["border-top-color", "border-bottom-color", "border-left-color", "border-right-color"]],
  ["border-inline-start-color", ["border-top-color", "border-bottom-color", "border-left-color", "border-right-color"]],
  ["border-inline-end-color", ["border-top-color", "border-bottom-color", "border-left-color", "border-right-color"]],
  ["border-block-color", ["border-block-start-color", "border-block-end-color"]],
  ["border-inline-color", ["border-inline-start-color", "border-inline-end-color"]],
  ["border-block-start", ["border-top", "border-bottom", "border-left", "border-right"]],
  ["border-block-end", ["border-top", "border-bottom", "border-left", "border-right"]],
  ["border-inline-start", ["border-top", "border-bottom", "border-left", "border-right"]],
  ["border-inline-end", ["border-top", "border-bottom", "border-left", "border-right"]],
  ["border-block", [ "border-block-start", "border-block-end"]],
  ["border-inline", ["border-inline-start", "border-inline-end"]],
  ["border-start-start-radius", ["border-top-left-radius", "border-bottom-left-radius", "border-top-right-radius", "border-bottom-right-radius"]],
  ["border-start-end-radius", ["border-top-left-radius", "border-bottom-left-radius", "border-top-right-radius", "border-bottom-right-radius"]],
  ["border-end-start-radius", ["border-top-left-radius", "border-bottom-left-radius", "border-top-right-radius", "border-bottom-right-radius"]],
  ["border-end-end-radius", ["border-top-left-radius", "border-bottom-left-radius", "border-top-right-radius", "border-bottom-right-radius"]],
];

// Recursively expands a prop name into a flat list of prop names that don't appear in the map as keys
const expandProp = (
  logicalPropsMaps: LogicalPropsMaps,
  prop: string
): string | string[] => {
  const mapFind = logicalPropsMaps.find((map) => map[0] === prop);
  if (!mapFind) return prop;
  const newProps = mapFind[1].map((newProp) =>
    expandProp(logicalPropsMaps, newProp)
  );
  return newProps.flat(1);
};

function expandLogicalProps(logicalPropsMaps: LogicalPropsMaps) {
  const final: LogicalPropsMaps = [];
  for (const prop of logicalPropsMaps) {
    const expanded = expandProp(logicalPropsMaps, prop[0]);
    const expandedLst = typeof expanded === "object" ? expanded : [expanded];
    // Remove duplicates from expandedLst
    final.push([prop[0], Array(...new Set(expandedLst))]);
  }
  return final;
}

// This recursive expansion of the auto-generated logicalPropsMaps_ is so that
//  every logical property maps to the full possible list of *physical properties*
//  it may map to in resolution. Namely, the mappings of shorthand logical properties
//  are fully expanded.
const logicalPropsMaps = expandLogicalProps(logicalPropsMaps_);

console.log(logicalPropsMaps);

function mapPropToPhysical(propName: string, el: Element): string[] {
  // Determine how the "block" and "inline" properties should be interpreted using getComputedStyle on el.
  //  They should be mapped to the physical "top", "right", "bottom", and "left" properties, with "width" being interpreted
  //  as "left" and "right" and "height" being interpreted as "top" and "bottom"
  if (!logicalPropsMaps.some(([logical]) => logical === propName)) {
    // If the property is not a logical propety but is a shorthand, expand the shorthand
    //  Note: The code handling logical properties also expands shorthand logical properties, which
    //         removes the need of using "css-shorthand-properties" in that case (and a good thing
    //         too, as the package doesn't deal with logical shorthand properties currently).
    if (isShorthand(propName)) return expand(propName, true).flat();
    // If the property is not a logical property and not shorthand, return it as is.
    else return [propName];
  }

  const computedStyle = window.getComputedStyle(el);

  const writingMode =
    computedStyle.getPropertyValue("writing-mode") || "horizontal-tb";

  const direction = computedStyle.getPropertyValue("direction") || "ltr";
  const isLTR = direction === "ltr";

  const orientation = computedStyle.getPropertyValue("text-orientation");
  const isUpright = orientation === "upright";

  type PhysicalDir = "top" | "right" | "bottom" | "left";
  let blockStart: PhysicalDir, inlineStart: PhysicalDir;
  // This logic is very specific, and derived from systematically trying all combinations
  //  using Firefox and the inspector
  if (writingMode === "horizontal-tb") {
    blockStart = "top";
    inlineStart = isLTR ? "left" : "right";
  } else if (writingMode === "vertical-rl") {
    blockStart = "right";
    inlineStart = isLTR || isUpright ? "top" : "bottom";
  } else if (writingMode === "sideways-rl") {
    blockStart = "right";
    inlineStart = isLTR ? "top" : "bottom";
  } else if (writingMode === "vertical-lr") {
    blockStart = "left";
    inlineStart = isLTR || isUpright ? "top" : "bottom";
  } else if (writingMode === "sideways-lr") {
    blockStart = "left";
    // This discrepancy is particularly interesting/strange
    inlineStart = isLTR ? "bottom" : "top";
  }

  const oppositeDir = (dir: PhysicalDir): PhysicalDir => {
    if (dir === "top") return "bottom";
    else if (dir === "bottom") return "top";
    else if (dir === "left") return "right";
    else if (dir === "right") return "left";
    else
      throw new Error("'dir' must be one of 'top', 'right', 'bottom', 'left'");
  };

  const match = (paramName: string, dir: PhysicalDir) => {
    if (dir === "left" || dir === "right")
      return paramName.includes(dir) || paramName.includes("width");
    if (dir === "top" || dir === "bottom")
      return paramName.includes(dir) || paramName.includes("height");
  };

  const physicalProps = logicalPropsMaps.find(
    ([logical]) => logical === propName
  )![1];

  const filteredPhysicalProps = physicalProps.filter((physical) => {
    const logical = propName;
    // prettier-ignore
    // Maps to 1 other property
    if (logical.includes("block-start")) return match(physical, blockStart);
    else if (logical.includes("block-end")) return match(physical, oppositeDir(blockStart));
    else if (logical.includes("inline-start")) return match(physical, inlineStart);
    else if (logical.includes("inline-end")) return match(physical, oppositeDir(inlineStart));
    // Handling border-radius logical properties (e.g. border-start-end-radius -> border-top-right radius)
    //                                     essentially border-block-start-inline-end-radius
    else if (logical.includes("start-start")) return match(physical, blockStart) && match(physical, inlineStart);
    else if (logical.includes("start-end")) return match(physical, blockStart) && match(physical, oppositeDir(inlineStart));
    else if (logical.includes("end-start")) return match(physical, oppositeDir(blockStart)) && match(physical, inlineStart);
    else if (logical.includes("end-end")) return match(physical, oppositeDir(blockStart)) && match(physical, oppositeDir(inlineStart));
    // Shorthand that maps to 2 properties
    else if (logical.includes("block")) return match(physical, blockStart) || match(physical, oppositeDir(blockStart))
    else if (logical.includes("inline")) return match(physical, inlineStart) || match(physical, oppositeDir(inlineStart))
    // Shorthand that maps to 4 properties
    else return true;
  });

  return filteredPhysicalProps;
}

function expandProperty(
  originalProp: CSSPropertyInfo,
  element?: Element
): CSSPropertyInfo[] {
  // Helper to create an expanded prop, copying core details from the original
  const createPhysicalPropInfo = (physicalName: string): CSSPropertyInfo => ({
    name: physicalName,
    value: originalProp.value,
    important: originalProp.important,
    active: false, // Will be determined by cascade resolution
    inherited: false,
    source: originalProp.source,
    layerName: originalProp.layerName,
    specificity: originalProp.specificity,
    originalPropertyName: originalProp.name, // Link back to the original shorthand/logical property
    // Carry over internal cascade properties
    _ruleOrderIndex: originalProp._ruleOrderIndex,
    _ruleOrigin: originalProp._ruleOrigin,
  });
  if (!element) {
    // If no element context, cannot perform accurate expansion. Return original as-is.
    console.warn(
      `expandProperty: Cannot expand '${originalProp.name}' without element context. Treating as single physical property.`
    );
    return [createPhysicalPropInfo(originalProp.name)];
  }

  return mapPropToPhysical(originalProp.name, element).map((physicalPropName) =>
    createPhysicalPropInfo(physicalPropName)
  );
}
