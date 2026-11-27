import { configured, waitUser, isAdmin, loginWith, errText, setupNotice } from "./fb.js";

const app = document.getElementById("app");
if (!configured) {
  setupNotice(app);
} else {
  const user = await waitUser();
  if (user) go(user);

  const form = document.getElementById("form");
  const err = document.getElementById("err");
  const btn = document.getElementById("go");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    err.textContent = "";
    btn.disabled = true; btn.textContent = "登入中…";
    try {
      const cred = await loginWith(document.getElementById("id").value, document.getElementById("pw").value);
      go(cred.user);
    } catch (ex) {
      err.textContent = errText(ex);
      btn.disabled = false; btn.textContent = "登入";
    }
  });
}

function go(user) { location.replace(isAdmin(user) ? "teacher.html" : "student.html"); }
