(() => {
  const header = document.querySelector(".df-header");
  if (header) {
    const sync = () => header.classList.toggle("is-scrolled", window.scrollY > 12);
    window.addEventListener("scroll", sync, { passive: true });
    sync();
  }

  const btn = document.querySelector(".df-menu-btn");
  const nav = document.getElementById("df-mobile-nav");
  if (btn && nav) {
    const close = () => {
      nav.classList.remove("is-open");
      nav.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      nav.classList.add("is-open");
      nav.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    };

    btn.addEventListener("click", () => {
      if (nav.classList.contains("is-open")) close();
      else open();
    });
    nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  // sodium-bootstrap: mount WebMCP tools (bundled from sodium-bootstrap.mjs)
  const sodiumSrc = "/assets/js/sodium.js";
  if (!document.querySelector(`script[src="${sodiumSrc}"]`)) {
    const s = document.createElement("script");
    s.type = "module";
    s.src = sodiumSrc;
    s.defer = true;
    document.head.appendChild(s);
  }
})();
