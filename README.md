# JavaScript Implementation of the CSS Cascade Algorithm

<div align="center"><img src="./public/js-css-cascade-logo.png" width="30%"></div>
<div align="center" font-size="20px"><em>Currently, as far as I know, the best (and pretty much only) JavaScript implementation publicly available.</em></div>

\
This was a short and largely experimental project of getting LLMs to write an implementation of the CSS cascade algorithm, after learning that no modern third-party solution existed.

This obviously doesn't provide a mission-critical spec-savvy ultra-realistic implementation of the cascade algorithm&mdash;and I don't plan to maintain it much at all beyond my own needs&mdash;but it should be pretty good in the majority of cases. It should correctly handle:

- CSS `@layer` at-rules (the precedence of rules between layers, other layers, and unlayered rules)
- Property `!important` declarations (apparently the precedence among `!important` properties reverses the usual `Inline > Author > User Agent`, who knew? And also that declaring `!important!important` doesn't actually do anything&mdash; I swear it did...)
- Shorthand properties overshadowing and getting correctly overshadowed by corresponding longhand properties (by being internally mapped to its longhands)
- Logical properties getting internally mapped to the appropriate physical properties (thus also correctly participating in the overshadowing process)
- Rules inside `@media` and `@supports` at-rules only applying if the queries are satisfied (_there is also logic for container queries, though those are quite modern and no API exists yet to determine whether a container query is being satisfied or not- something like `Element.matchContainer()`_)
- Properties being inherited (_though this wasn't a priority, and not really tested at all_)

There is a function for discovering all of the rules across all of the stylesheets currently in the document called `getAllCSSRules()` which generates all the vital information which makes the output of the cascade interesting. The cascade algorithm itself is implemented in the `resolveCascadeForElement()` function, which&mdash;as the name suggests&mdash;finds all of the styles (as they are written in the stylesheets, different from simply using `getComputedStyle()`) that apply to the given element, giving the information of how the element got its visual appearance, as well as information on the cascade process itself.

`getAllCSSRules()` also takes in detached sheets (i.e. `CSSStyleSheet` objects not in `document.styleSheets`) that you would like to be considered by the cascade algorithm. In the demo, I put in a copy of one of Firefox's User-Agent stylesheets (because UA stylesheets aren't discoverable through `document.styleSheets`). And on top of performing the cascade, `resolveCascadeForElement()` also discovers the inline styles of the element which is being passed in, so that they too may participate.

All of the interesting code is inside [src/cascade.ts](src/cascade.ts). The Vite/Svelte app around it serves as a tech demo for this cascade algorithm implementation. To see the demo, run the following:

```
npm install
npm run dev
```

...Or visit the [publicly hosted version](https://martinm07.github.io/js-css-cascade-algorithm.github.io/).

---

As mentioned, LLMs (Google Gemini, Claude and Copilot) were instrumental in the writing of this code. The majority of the work was done in a singular [chat on Gemini](https://gemini.google.com/share/3ab55210d6b2), which had started with me asking it to research alternatives to [brothercake's CSSUtilities](https://brothercake.com/site/resources/scripts/cssutilities/) script, which had provided essentially the same functionality as this project, but was unfortunately not updated in 15 years and is not able to understand CSS Level 4 specification features, most notably `@layer` at-rules which it ignores (including all the rules within).

If there is interest, there are things I can think of for improving the project and cleaning up the API:

- Move inline style discovery away from `resolveCascadeForElement()` and into some new function.
- Have rules containing inherited properties be included in `.matchingRules` in the output of `resolveCascadeForElement()`, and include information of inheritence paths/sources like in CSSUtilities.
- Have more options for how the cascade runs e.g. ignore inherited properties, ignore certain layers, assume certain `@media` or `@supports` or `@container` contexts.
- Include support for the `@scope` at-rule (and potentially others I've missed).
- Be able to resolve the cascade for multiple elements at once, letting the algorithm share data and improve overall performance.
- Include information for rules/properties that may not be active currently but can become active under certain pseudo-state (based on the rule selector) e.g. `:hover`
- Improve data structures in general (currently it is a bit of a mess&mdash; on `CSSPropertyInfo`, `overshadowedBy` is not very useful, `specificity` shouldn't exist, and neither should `layerName` or `source`. On `CSSRuleAnalysis`, `layerName`, `stylesheetUrl`, and `conditionalContexts` could be combined into some general description of ownership of this rule. On `ElementStateAnalysis`, `element` and `computedStyles` don't seem useful, and more).

## Contributing

Feel free to reach out if your interest has been piqued&mdash; don't be a stranger :-)
