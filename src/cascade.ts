import Specificity from "@bramus/specificity";
import { parse as parseLayerNames } from "@csstools/cascade-layer-name-parser";
import { expand, isShorthand } from "css-shorthand-properties";

console.log(expand("margin", false));

/**
 * Represents detailed information about a single CSS property declaration.
 */
interface CSSPropertyInfo {
  name: string; // The physical property name (e.g., 'margin-left')
  value: string;
  important: boolean;
  source: string; // e.g., "inline", "stylesheet.css"
  layerName?: string; // The name of the @layer this property belongs to, if any
  specificity?: [number, number, number]; // specificity score (copied from parent rule for sorting)
  active: boolean; // True if this property is actively applied, false if overshadowed
  overshadowedBy?: { ruleSelector: string; layerName?: string }; // Details of the rule that overshadowed it
  inherited: boolean; // True if this property's value is inherited from an ancestor
  _ruleOrderIndex?: number; // Internal: global order of appearance of the rule for tie-breaking
  _ruleOrigin?:
    | "user-agent"
    | "user"
    | "author"
    | "inline"
    | "animation"
    | "transition"; // Internal: origin of the rule
  _ruleContainsImportant?: boolean; // Internal: whether the parent rule contains any !important properties
  originalPropertyName?: string; // The original declared property name (e.g., 'margin' if expanded)
}

/**
 * Represents a parsed CSS rule with additional analytical metadata.
 */
interface CSSRuleAnalysis {
  selector: string;
  specificity: [number, number, number];
  properties: CSSPropertyInfo[]; // Array of properties in this rule (now includes expanded physical properties)
  stylesheetUrl: string;
  lineNumber?: number; // Approximate line number, if available from parsing (CSSOM usually doesn't provide)
  layerName?: string; // The name of the @layer this rule belongs to, if any
  origin:
    | "user-agent"
    | "user"
    | "author"
    | "inline"
    | "animation"
    | "transition";
  containsImportant: boolean; // True if any property within this rule is !important
  orderIndex: number; // Global order of appearance for tie-breaking
}

/**
 * Represents the comprehensive style analysis for a specific HTML element.
 */
interface ElementStyleAnalysis {
  element: Element;
  computedStyles: CSSStyleDeclaration; // The final computed styles from the browser (for validation)
  matchingRules: CSSRuleAnalysis[]; // All rules that match the element, before cascade resolution
  finalProperties: { [key: string]: CSSPropertyInfo }; // The winning properties for the element after cascade
}

// Global map to store the declared order of layers
// This map captures the order in which layers are *first declared* via @layer statements or blocks.
const globalLayerOrderMap = new Map<string, number>();
let layerOrderCounter = 0;

// Set to keep track of processed stylesheets to prevent infinite loops (e.g., circular @import)
const processedSheets = new Set<string>();

/**
 * Gathers all CSS rules from the document's stylesheets, parsing them and extracting relevant metadata,
 * including cascade layer information.
 *
 * @returns A promise resolving to an array of CSSRuleAnalysis objects, representing all found CSS rules
 * with their associated metadata.
 */
export async function getAllCSSRules(): Promise<CSSRuleAnalysis[]> {
  const allRules: CSSRuleAnalysis[] = [];

  /**
   * Recursively processes a CSSStyleSheet or CSSGroupingRule (like CSSMediaRule, CSSLayerBlockRule),
   * extracting CSS rules and their metadata.
   *
   * @param sheetOrRule The stylesheet or CSS grouping rule to process.
   * @param currentLayerName The name of the current cascade layer context (optional, inherited from parent).
   */
  async function processCSSRules(
    sheetOrRule: CSSStyleSheet | CSSGroupingRule,
    currentLayerName?: string
  ): Promise<void> {
    // Generate a unique identifier for the current sheet/rule to prevent reprocessing
    const identifier =
      sheetOrRule instanceof CSSStyleSheet && sheetOrRule.href
        ? sheetOrRule.href
        : sheetOrRule instanceof CSSStyleSheet && sheetOrRule.ownerNode
        ? `inline-style-${(sheetOrRule.ownerNode as HTMLElement).outerHTML}` // Unique for inline <style> tags
        : `rule-group-${sheetOrRule.constructor.name}-${Math.random()}`; // Fallback for unnamed grouping rules

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
        sheetOrRule instanceof CSSSupportsRule
      ) {
        rules = sheetOrRule.cssRules;
      } else {
        console.error(sheetOrRule);
        throw new Error("Unsupported rule type");
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
        const properties: CSSPropertyInfo[] = []; // This will now store expanded physical properties
        let ruleContainsImportant = false;

        // Iterate through each declaration within the style rule
        for (let j = 0; j < cssRule.style.length; j++) {
          const originalName = cssRule.style[j]; // The original property name (e.g., 'margin', 'margin-inline-start')
          const value = cssRule.style.getPropertyValue(originalName);
          const important =
            cssRule.style.getPropertyPriority(originalName) === "important";
          if (important) {
            ruleContainsImportant = true;
          }

          // --- NEW LOGIC: Expand originalName to its physical properties ---
          const physicalPropNames = expandLogicalProp(originalName); // Assumed external function

          // If expandLogicalProp returns no specific mapping, treat the original as a physical property
          if (physicalPropNames.length === 0) {
            physicalPropNames.push(originalName);
          }

          physicalPropNames.forEach((physicalName) => {
            properties.push({
              name: physicalName, // Now it's the physical property name
              value,
              important,
              active: false,
              inherited: false,
              source: cssRule.parentStyleSheet?.href || "inline",
              layerName: currentLayerName,
              specificity: specificityScore,
              originalPropertyName: originalName, // Store original for tracing
            });
          });
          // --- END NEW LOGIC ---
        }

        allRules.push({
          selector,
          specificity: specificityScore,
          properties, // This now contains expanded physical properties
          stylesheetUrl: cssRule.parentStyleSheet?.href || "inline",
          lineNumber: undefined, // CSSOM does not directly expose line numbers
          layerName: currentLayerName,
          origin: getOriginFromSheet(cssRule.parentStyleSheet),
          containsImportant: ruleContainsImportant,
          orderIndex: allRules.length, // Assign a global order index for tie-breaking
        });
      }
      // 3.2. Handle `CSSMediaRule` (e.g., `@media screen { ... }`):
      else if (cssRule instanceof CSSMediaRule) {
        // Recursively process rules within the media block, passing the current layer name
        await processCSSRules(cssRule, currentLayerName);
      }
      // 3.3. Handle `CSSImportRule` (e.g., `@import "another.css";`):
      else if (cssRule instanceof CSSImportRule) {
        // If the imported stylesheet is accessible (same origin), recursively process it
        if (cssRule.styleSheet) {
          await processCSSRules(cssRule.styleSheet, currentLayerName);
        }
      }
      // 3.4. Handle `CSSLayerBlockRule` (e.g., `@layer components { ... }`):
      else if (cssRule instanceof CSSLayerBlockRule) {
        const layerName = cssRule.name;
        // Record the layer's declaration order if it's new.
        // This ensures globalLayerOrderMap captures the *first appearance* of each layer name.
        if (!globalLayerOrderMap.has(layerName)) {
          globalLayerOrderMap.set(layerName, layerOrderCounter++);
        }
        // Recursively process rules inside this named layer block, passing its name
        await processCSSRules(cssRule, layerName);
      }
      // 3.5. Handle `CSSLayerStatementRule` (e.g., `@layer base, components;`):
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
      // 3.6. Handle other `CSSRule` types if necessary (e.g., CSSSupportsRule, CSSKeyframesRule)
      // For this analysis, we'll primarily focus on style rules and layering.
      else if (cssRule instanceof CSSSupportsRule) {
        await processCSSRules(cssRule, currentLayerName);
      }
    }
  }

  // Start processing from all document stylesheets
  for (const sheet of Array.from(document.styleSheets)) {
    // Cast to CSSStyleSheet as `document.styleSheets` typically contains this type
    await processCSSRules(sheet as CSSStyleSheet);
  }

  return allRules;
}

/**
 * Calculates the specificity of a CSS selector using @bramus/specificity.
 * @param selector The CSS selector string.
 * @returns A tuple representing the specificity [A, B, C].
 */
function calculateSpecificity(selector: string): [number, number, number] {
  if (!selector) {
    return [0, 0, 0];
  }
  // @bramus/specificity returns an array of Specificity instances, one for each selector in a list.
  // We expect a single selector here, so we take the first element.
  const specificities = Specificity.calculate(selector);
  if (specificities.length === 0) {
    // Should not happen for valid selectors but as a safeguard
    return [0, 0, 0];
  }
  const s = specificities[0];
  return [s.a, s.b, s.c];
}

/**
 * Determines the origin of a stylesheet.
 * @param sheet The CSSStyleSheet object or null for inline style attributes.
 * @returns The origin type ('user-agent', 'user', 'author', 'inline', 'animation', 'transition').
 */
function getOriginFromSheet(
  sheet: CSSStyleSheet | null
): "user-agent" | "user" | "author" | "inline" | "animation" | "transition" {
  // For direct inline style attributes (element.style), this function is not called.
  // For <style> tags, sheet.href is null, so it falls to 'author' by default.
  if (!sheet) {
    // This case is technically not hit for CSSRuleAnalysis created from CSSOM,
    // as CSSRuleAnalysis is for rules found in sheets/style tags.
    return "inline"; // Represents inline <style> tags, though technically 'author' origin
  }

  // Heuristics for user-agent stylesheets (often have specific prefixes or no href)
  if (sheet.href) {
    if (
      sheet.href.startsWith("chrome-extension://") ||
      sheet.href.startsWith("resource://") ||
      sheet.href.startsWith("about:")
    ) {
      return "user-agent";
    }
  }
  return "author";
}

/**
 * Filters the global list of rules to find those that match a given element.
 * @param element The HTMLElement to match rules against.
 * @param allRules The comprehensive list of all parsed CSS rules.
 * @returns An array of CSSRuleAnalysis objects that match the element.
 */
function getMatchingRulesForElement(
  element: Element,
  allRules: CSSRuleAnalysis[]
): CSSRuleAnalysis[] {
  return allRules.filter((rule) => {
    try {
      // Use native Element.matches() for efficient selector matching
      // This is generally reliable for CSS selectors, even complex ones.
      return element.matches(rule.selector);
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
 * Resolves the final styles for an element by applying the CSS cascade algorithm.
 * @param element The HTMLElement to analyze.
 * @param allRules The comprehensive list of all parsed CSS rules.
 * @returns An ElementStyleAnalysis object containing the resolved styles and cascade details.
 */
export function resolveCascadeForElement(
  element: Element,
  allRules: CSSRuleAnalysis[]
): ElementStyleAnalysis {
  const matchingRules = getMatchingRulesForElement(element, allRules);
  const finalProperties: { [key: string]: CSSPropertyInfo } = {};
  const propertiesToConsider: { [key: string]: CSSPropertyInfo[] } = {};

  matchingRules.forEach((rule) => {
    rule.properties.forEach((prop) => {
      // Group declarations by their *physical* property name
      if (!propertiesToConsider[prop.name]) {
        propertiesToConsider[prop.name] = [];
      }
      // Add rule-level metadata to each property for comprehensive cascade sorting
      propertiesToConsider[prop.name].push({
        ...prop,
        _ruleOrderIndex: rule.orderIndex,
        _ruleOrigin: rule.origin,
        _ruleContainsImportant: rule.containsImportant,
        specificity: rule.specificity, // Use rule's specificity directly
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

    let score = 0; // Base score for this declaration

    // Step 1: Handle Transitions (absolute highest and lowest in the cascade)
    if (origin === "transition") {
      return isImportant ? Infinity : -Infinity; // Transitions are always highest !important or lowest normal
    }

    // Step 2: Handle !important declarations (high precedence group)
    if (isImportant) {
      // Order from highest !important to lowest !important (excluding transitions):
      // User-agent > User > Inline > Author (layered: earlier declared wins) > Author (unlayered) > Animation
      if (origin === "user-agent") score = 1000;
      else if (origin === "user") score = 900;
      else if (origin === "inline")
        score = 800; // Inline `style` attribute (!important)
      else if (origin === "author") {
        // Author !important rules have a base score, then adjusted by layer.
        // Earlier declared layers win for !important.
        score = 700; // Base score for author !important
        if (isLayered) {
          // For !important, smaller layerOrder (earlier declared) gets a higher score.
          // If layerOrder is 0 (first declared), it gets the max bonus (totalLayers - 0).
          score += totalLayers - (layerOrder || 0); // (layerOrder || 0) handles undefined safely
        } else {
          // Unlayered !important author declarations are *lower* than any layered !important author rules.
          // Giving them a score equal to the base without layer bonus ensures this.
          score += 0;
        }
      } else if (origin === "animation") score = 600; // Animation !important is weakest among important declarations.
    }
    // Step 3: Handle Normal declarations (lower precedence group)
    else {
      // Order from highest normal to lowest normal (excluding transitions):
      // Animation > Inline > Author (unlayered) > Author (layered: later declared wins) > User > User-agent
      if (origin === "animation")
        score = 500; // Animation normal is highest among normal declarations.
      else if (origin === "inline")
        score = 400; // Inline `style` attribute (normal)
      else if (origin === "author") {
        // Author normal rules have a base score, then adjusted by layer.
        // Unlayered author normal declarations are *higher* than any layered author normal rules.
        // Later declared layers win for normal rules.
        score = 300; // Base score for author normal
        if (isLayered) {
          // For normal, larger layerOrder (later declared) gets a higher score.
          score += layerOrder || 0;
        } else {
          // Unlayered normal author is *stronger* than any layered normal author.
          // Giving it a score higher than the max possible layered score ensures this.
          score += totalLayers + 100;
        }
      } else if (origin === "user") score = 200;
      else if (origin === "user-agent") score = 100;
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
        if (a.specificity[0] !== b.specificity[0])
          return b.specificity[0] - a.specificity[0];
        if (a.specificity[1] !== b.specificity[1])
          return b.specificity[1] - a.specificity[1];
        if (a.specificity[2] !== b.specificity[2])
          return b.specificity[2] - a.specificity[2];
      }

      // 3. Order of Appearance (final tie-breaker if all else is equal)
      return a._ruleOrderIndex! - b._ruleOrderIndex!; // Earlier declared rule wins
    });

    if (declarations.length > 0) {
      const winningDeclaration = declarations[0];
      // Store the winning declaration in finalProperties, cleaning up internal temp properties
      finalProperties[propName] = {
        ...winningDeclaration,
        active: true,
        _ruleOrderIndex: undefined,
        _ruleOrigin: undefined,
        _ruleContainsImportant: undefined,
      };

      // Mark overshadowed properties
      for (let i = 1; i < declarations.length; i++) {
        declarations[i].active = false;
        declarations[i].overshadowedBy = {
          ruleSelector:
            declarations[i].originalPropertyName || declarations[i].name, // Use original name for overshadowing info
          layerName: declarations[i].layerName,
        };
        // Clean up internal temp properties for overshadowed ones too
        declarations[i]._ruleOrderIndex = undefined;
        declarations[i]._ruleOrigin = undefined;
        declarations[i]._ruleContainsImportant = undefined;
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
    const inheritableProps = [
      "azimuth",
      "border-collapse",
      "border-spacing",
      "caption-side",
      "color",
      "cursor",
      "direction",
      "empty-cells",
      "font-family",
      "font-size",
      "font-style",
      "font-variant",
      "font-weight",
      "font",
      "letter-spacing",
      "line-height",
      "list-style-image",
      "list-style-position",
      "list-style-type",
      "list-style",
      "orphans",
      "quotes",
      "tab-size",
      "text-align",
      "text-indent",
      "text-transform",
      "visibility",
      "white-space",
      "widows",
      "word-break",
      "word-spacing",
      "word-wrap",
    ];
    return inheritableProps.includes(prop);
  }

  // Update the original matchingRules with the `active` status based on `finalProperties`
  const updatedMatchingRules = matchingRules.map((rule) => {
    const updatedProperties = rule.properties.map((prop) => {
      const finalProp = finalProperties[prop.name];
      // Check if this specific property declaration (from this rule) is the one that won
      // Compare all key identifiers to ensure it's the exact declaration instance
      if (
        finalProp &&
        finalProp.value === prop.value &&
        finalProp.important === prop.important &&
        finalProp.source === prop.source &&
        finalProp.layerName === prop.layerName &&
        prop.specificity?.[0] === finalProp.specificity?.[0] && // Compare specificity components too
        prop.specificity?.[1] === finalProp.specificity?.[1] &&
        prop.specificity?.[2] === finalProp.specificity?.[2] &&
        prop.originalPropertyName === finalProp.originalPropertyName // Compare original property name
      ) {
        return { ...prop, active: true };
      } else {
        return {
          ...prop,
          active: false,
          overshadowedBy: finalProp
            ? { ruleSelector: finalProp.source, layerName: finalProp.layerName }
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

/**
 * Placeholder for a function that expands a CSS property name (shorthand or logical)
 * into its corresponding physical longhand property names.
 *
 * NOTE: A full, robust implementation of this function is highly complex and would
 * require a comprehensive mapping of all CSS shorthands and logical properties to their
 * longhand/physical equivalents, potentially considering 'writing-mode', 'direction', etc.
 * For this example, it provides a basic, illustrative mapping.
 *
 * @param propName The original CSS property name (e.g., 'margin', 'margin-inline-start').
 * @returns An array of physical CSS property names that the original property maps to.
 */
// function expandLogicalProp(propName: string): string[] {
//   switch (propName) {
//     // Shorthand properties
//     case "margin":
//       return ["margin-top", "margin-right", "margin-bottom", "margin-left"];
//     case "padding":
//       return ["padding-top", "padding-right", "padding-bottom", "padding-left"];
//     case "border":
//       return [
//         "border-top-width",
//         "border-right-width",
//         "border-bottom-width",
//         "border-left-width",
//         "border-top-style",
//         "border-right-style",
//         "border-bottom-style",
//         "border-left-style",
//         "border-top-color",
//         "border-right-color",
//         "border-bottom-color",
//         "border-left-color",
//       ];
//     case "background":
//       return [
//         "background-image",
//         "background-position",
//         "background-size",
//         "background-repeat",
//         "background-origin",
//         "background-clip",
//         "background-attachment",
//         "background-color",
//       ];
//     case "font":
//       return [
//         "font-style",
//         "font-variant",
//         "font-weight",
//         "font-stretch",
//         "font-size",
//         "line-height",
//         "font-family",
//       ];
//     case "list-style":
//       return ["list-style-type", "list-style-position", "list-style-image"];
//     case "flex":
//       return ["flex-grow", "flex-shrink", "flex-basis"];
//     case "grid":
//       return [
//         "grid-template-rows",
//         "grid-template-columns",
//         "grid-template-areas",
//         "grid-auto-rows",
//         "grid-auto-columns",
//         "grid-auto-flow",
//         "grid-column-gap",
//         "grid-row-gap",
//       ];
//     case "outline":
//       return ["outline-width", "outline-style", "outline-color"];
//     case "columns":
//       return ["column-width", "column-count"];
//     case "text-decoration":
//       return [
//         "text-decoration-line",
//         "text-decoration-style",
//         "text-decoration-color",
//         "text-decoration-thickness",
//       ];
//     case "overflow":
//       return ["overflow-x", "overflow-y"];

//     // Logical properties - simplified mapping to *all possible* physical properties.
//     // A truly accurate implementation would require runtime context (e.g., element's writing-mode).
//     case "margin-inline":
//       return ["margin-left", "margin-right"];
//     case "margin-block":
//       return ["margin-top", "margin-bottom"];
//     case "margin-inline-start":
//       return ["margin-left", "margin-right"]; // Could be one based on writing-mode
//     case "margin-inline-end":
//       return ["margin-left", "margin-right"];
//     case "margin-block-start":
//       return ["margin-top", "margin-bottom"];
//     case "margin-block-end":
//       return ["margin-top", "margin-bottom"];

//     case "padding-inline":
//       return ["padding-left", "padding-right"];
//     case "padding-block":
//       return ["padding-top", "padding-bottom"];
//     case "padding-inline-start":
//       return ["padding-left", "padding-right"];
//     case "padding-inline-end":
//       return ["padding-left", "padding-right"];
//     case "padding-block-start":
//       return ["padding-top", "padding-bottom"];
//     case "padding-block-end":
//       return ["padding-top", "padding-bottom"];

//     case "border-inline":
//       return [
//         "border-left-width",
//         "border-left-style",
//         "border-left-color",
//         "border-right-width",
//         "border-right-style",
//         "border-right-color",
//       ];
//     case "border-block":
//       return [
//         "border-top-width",
//         "border-top-style",
//         "border-top-color",
//         "border-bottom-width",
//         "border-bottom-style",
//         "border-bottom-color",
//       ];
//     case "border-inline-start":
//       return [
//         "border-left-width",
//         "border-left-style",
//         "border-left-color",
//         "border-right-width",
//         "border-right-style",
//         "border-right-color",
//       ];
//     case "border-inline-end":
//       return [
//         "border-left-width",
//         "border-left-style",
//         "border-left-color",
//         "border-right-width",
//         "border-right-style",
//         "border-right-color",
//       ];
//     case "border-block-start":
//       return [
//         "border-top-width",
//         "border-top-style",
//         "border-top-color",
//         "border-bottom-width",
//         "border-bottom-style",
//         "border-bottom-color",
//       ];
//     case "border-block-end":
//       return [
//         "border-top-width",
//         "border-top-style",
//         "border-top-color",
//         "border-bottom-width",
//         "border-bottom-style",
//         "border-bottom-color",
//       ];

//     case "inset":
//       return ["top", "right", "bottom", "left"];
//     case "inset-inline":
//       return ["left", "right"];
//     case "inset-block":
//       return ["top", "bottom"];

//     case "width-inline":
//       return ["width"]; // Or 'height' depending on writing mode
//     case "height-block":
//       return ["height"]; // Or 'width' depending on writing mode

//     default:
//       // For custom properties (--my-prop) or other direct properties that don't expand.
//       // Check if it's a known longhand property that doesn't map further.
//       // This list is not exhaustive but covers common cases.
//       if (
//         [
//           "color",
//           "font-size",
//           "line-height",
//           "text-align",
//           "display",
//           "position",
//           "top",
//           "right",
//           "bottom",
//           "left",
//           "z-index",
//           "opacity",
//           "transform",
//           "background-color",
//           "width",
//           "height",
//           "min-width",
//           "max-width",
//           "min-height",
//           "max-height",
//           "border-radius",
//           "box-shadow",
//           "text-shadow",
//           "cursor",
//           "overflow-x",
//           "overflow-y",
//           "gap",
//           "row-gap",
//           "column-gap",
//           "flex-direction",
//           "justify-content",
//           "align-items",
//           "align-self",
//           "flex-wrap",
//           "order",
//           "grid-template-rows",
//           "grid-template-columns",
//           "grid-template-areas",
//           "grid-row-start",
//           "grid-row-end",
//           "grid-column-start",
//           "grid-column-end",
//         ].includes(propName) ||
//         propName.startsWith("--")
//       ) {
//         return [propName];
//       }
//       // For any other unrecognized property, return it as-is.
//       console.warn(
//         `expandLogicalProp: Unknown property '${propName}', returning as-is.`
//       );
//       return [propName];
//   }
// }

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

const logicalPropsMaps = expandLogicalProps(logicalPropsMaps_);

console.log(logicalPropsMaps);

function expandLogicalProp(propName: string, el: Element): string[] {
  // Determine how the "block" and "inline" properties should be interpreted using getComputedStyle on el.
  //  They should be mapped to the physical "top", "right", "bottom", and "left" properties, with "width" being interpreted
  //  as "left" and "right" and "height" being interpreted as "top" and "bottom"
  if (!logicalPropsMaps.some(([logical]) => logical === propName)) {
    if (isShorthand(propName)) return expand(propName, true).flat();
    // If the property is not a logical property and not shorthand, return it as is.
    else return [propName];
  }

  const computedStyle = window.getComputedStyle(el);
  const writingMode =
    computedStyle.getPropertyValue("writing-mode") || "horizontal-tb";
  const direction = computedStyle.getPropertyValue("direction") || "ltr";

  const isLTR = direction === "ltr";

  type PhysicalDir = "top" | "right" | "bottom" | "left";
  let blockStart: PhysicalDir, inlineStart: PhysicalDir;
  if (writingMode === "horizontal-tb") {
    blockStart = "top";
    inlineStart = isLTR ? "left" : "right";
  } else if (writingMode === "vertical-rl" || writingMode === "sideways-rl") {
    blockStart = "right";
    inlineStart = isLTR ? "top" : "bottom";
  } else if (writingMode === "vertical-lr") {
    blockStart = "left";
    inlineStart = isLTR ? "top" : "bottom";
  } else if (writingMode === "sideways-lr") {
    blockStart = "left";
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
    // if (logical.includes("start") || logical.includes("end")) {
    //   if (logical.includes("block"))
    // }
    // Maps to 1 other property
    if (logical.includes("block-start")) return match(physical, blockStart);
    else if (logical.includes("block-end"))
      return match(physical, oppositeDir(blockStart));
    else if (logical.includes("inline-start"))
      return match(physical, inlineStart);
    else if (logical.includes("inline-end"))
      return match(physical, oppositeDir(inlineStart));
    // Shorthand that maps to 2 properties
    else if (logical.includes("block"))
      return (
        match(physical, blockStart) || match(physical, oppositeDir(blockStart))
      );
    else if (logical.includes("inline"))
      return (
        match(physical, inlineStart) ||
        match(physical, oppositeDir(inlineStart))
      );
    // Shorthand that maps to 4 properties
    else return true;
  });

  return filteredPhysicalProps;
}
