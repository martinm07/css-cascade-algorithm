# JavaScript Implementation of the CSS Cascade Algorithm

<div style="text-align: center;"><img src="./public/js-css-cascade-logo.png" width="30%"></div>
<div style="text-align: center; font-size: 1.5em;"><em>Currently, as far as I know, the best (and pretty much only) JavaScript implementation publicly available.</em></div>

\
This was a short and largely experimental project of getting LLMs to write an implementation of the CSS cascade algorithm, after learning that no modern third-party solution existed.

This obviously doesn't provide a mission-critical spec-savvy ultra-realistic implementation of the cascade algorithm&mdash;and I don't plan to maintain it much at all beyond my own needs&mdash;but it should be pretty good in the majaority of cases. It should correctly handle:

- CSS `@layer` at-rules (the precedence of rules between layers, other layers, and unlayered rules)
- Property `!important` declarations (apparently the precedence among `!important` properties reverses the usual `Inline > Author > User Agent`, who knew? And also that declaring `!important!important` doesn't actually do anything&mdash; I swear it did...)
- Shorthand properties overshadowing and getting correctly overshadowed by corresponding longhand properties (by being internally mapped to its longhands)
- Logical properties getting internally mapped to the appropriate physical properties (thus also correctly participating in the overshadowing process)
- Rules inside `@media` and `@supports` at-rules only applying if the queries are satisfied (_there is also logic for container queries, though those are quite modern and no API exists yet to determine whether a container query is being satisfied or not- something like `Element.matchContainer()`_)
- Properties being inherited (_though this wasn't a priority, and not really tested at all_)

There is a function for discovering all of the rules across all of the stylesheets currently in the document called `getAllCSSRules()` which generates all the vital information which makes the output of the cascade interesting. The cascade algorithm itself is implemented in the `resolveCascadeForElement()` function, which&mdash;as the name suggests&mdash;finds all of the styles (as they are written in the stylesheets, different from simply using `getComputedStyle()`) that apply to the given element, giving the information of how the element got its visual appearance, as well as information on the cascade process itself.

`getAllCSSRules()` also takes in detached sheets (i.e. `CSSStyleSheet` objects not in `document.styleSheets`) that you would like to be considered by the cascade algorithm. In the demo, I put in a copy of one of Firefox's User-Agent stylesheets (because UA stylsheets aren't discoverable through `document.styleSheets`). And on top of performing the cascade, `resolveCascadeForElement()` also discovers the inline styles of the element which is being passed in, so that they too may participate.

All of the interesting code is inside [src/cascade.ts](src/cascade.ts). The Vite/Svelte app around it serves as a tech demo for this cascade algorithm implementation. To see the demo, run the following:

```
npm install
npm run dev
```

---

As mentioned, LLMs (Google Gemini, Claude and Copilot) were instrumental in the writing of this code. The majority of the work was done in a singular [chat on Gemini](https://gemini.google.com/share/3ab55210d6b2), which had started with me asking it to research alternatives to [brothercake's CSSUtilities](https://brothercake.com/site/resources/scripts/cssutilities/) script, which had provided essentially the same functionality as this project, but was unfortunately not updated in 15 years and is not able to understand CSS Level 4 specification features, most notably `@layer` at-rules which it ignores (including all the rules within).
