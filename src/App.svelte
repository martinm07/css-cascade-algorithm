<script lang="ts">
  import svelteLogo from "./assets/svelte.svg";
  import viteLogo from "./assets/vite.svg";
  import firefoxStylesPath from "./assets/firefoxDefaultCSS.txt";

  import { getAllCSSRules, resolveCascadeForElement } from "./cascade";

  let selectorValue: string = $state("");

  const UAStyles = new CSSStyleSheet();
  fetch(firefoxStylesPath)
    .then((resp) => resp.text())
    .then((firefoxDefaultCSS) => {
      UAStyles.replaceSync(firefoxDefaultCSS);
      console.log(UAStyles);
    });

  async function runCascade() {
    // The custom href is used by the getOriginFromSheet to determine
    //  that this is a user-agent stylesheet.
    const rules = await getAllCSSRules([
      { sheet: UAStyles, href: "resource://user-agent-styles.css" },
    ]);
    console.log("All CSS Rules:", rules);

    const el = document.querySelector(selectorValue);
    if (!el) {
      console.warn(`No element found for selector "${selectorValue}"`);
      return;
    }
    console.log("Resolving cascade for following element:", el);
    const result = resolveCascadeForElement(el, rules);
    console.log(result);
  }
</script>

<main>
  <div>
    <a href="https://vite.dev" target="_blank" rel="noreferrer">
      <img src={viteLogo} class="logo" alt="Vite Logo" />
    </a>
    <a href="https://svelte.dev" target="_blank" rel="noreferrer">
      <img src={svelteLogo} class="logo svelte" alt="Svelte Logo" />
    </a>
  </div>
  <h1>CSS Cascade Algorithm Implementation</h1>

  <div class="card">
    <input
      type="text"
      name="Selector"
      id=""
      placeholder=".your-selector"
      bind:value={selectorValue}
    />
    <button onclick={runCascade}> Run Cascade </button>
  </div>

  <p>
    Check out <a
      href="https://github.com/sveltejs/kit#readme"
      target="_blank"
      rel="noreferrer">SvelteKit</a
    >, the official Svelte app framework powered by Vite!
  </p>

  <p class="read-the-console">
    Open the console to find the results of the cascade emulation.
  </p>
</main>

<style>
  .logo {
    height: 6em;
    padding: 1.5em;
    will-change: filter;
    transition: filter 300ms;
  }
  .logo:hover {
    filter: drop-shadow(0 0 2em #646cffaa);
  }
  .logo.svelte:hover {
    filter: drop-shadow(0 0 2em #ff3e00aa);
  }
  .read-the-console {
    color: #888;
  }
</style>
