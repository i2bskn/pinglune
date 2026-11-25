// Keep the native POST/redirect/error flow; only prevent another decision while it is pending.
const form = document.getElementById("consent-form");
if (form) {
  const buttons = [...form.querySelectorAll('button[type="submit"]')];
  let pendingDecision;

  form.addEventListener("submit", (event) => {
    if (pendingDecision) {
      event.preventDefault();
      return;
    }
    if (event.defaultPrevented) return;
    const submitter = event.submitter;
    if (!buttons.includes(submitter)) return;

    // Disabled submit buttons are excluded from the POST body. Preserve the chosen decision first.
    pendingDecision = document.createElement("input");
    pendingDecision.type = "hidden";
    pendingDecision.name = submitter.name;
    pendingDecision.value = submitter.value;
    form.append(pendingDecision);
    form.setAttribute("aria-busy", "true");
    for (const button of buttons) button.disabled = true;
  });

  // A page restored from the back/forward cache must not stay disabled.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    pendingDecision?.remove();
    pendingDecision = undefined;
    form.removeAttribute("aria-busy");
    for (const button of buttons) button.disabled = false;
  });
}
