// Firebase 初始化與共用工具。所有頁面都只透過這個檔案使用 Firebase。
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  onAuthStateChanged, updatePassword, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";
import { firebaseConfig, ADMIN_UID, LOGIN_DOMAIN } from "./config.js";

export const configured = !/填入/.test(firebaseConfig.apiKey + firebaseConfig.projectId + ADMIN_UID);
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export function isAdmin(user) { return !!user && user.uid === ADMIN_UID; }

export function waitUser() {
  return new Promise(resolve => {
    const stop = onAuthStateChanged(auth, u => { stop(); resolve(u); });
  });
}

// 帳號含 @ 視為老師 Email；否則是學生帳號（例：711-05），先查出內部 Email 再登入
export async function loginWith(id, password) {
  id = String(id || "").trim();
  let email = id;
  if (!id.includes("@")) {
    const snap = await getDoc(doc(db, "logins", id.toLowerCase()));
    if (!snap.exists()) { const e = new Error("no account"); e.code = "app/no-account"; throw e; }
    email = snap.data().email;
  }
  return signInWithEmailAndPassword(auth, email, password);
}

// 用第二個 Firebase 執行個體建立學生帳號，老師本身不會被登出
let secondaryAuth = null;
export async function createStudentAuth(loginId, password) {
  if (!secondaryAuth) secondaryAuth = getAuth(initializeApp(firebaseConfig, "secondary"));
  const email = `${loginId}.${Date.now().toString(36)}@${LOGIN_DOMAIN}`;
  const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
  const uid = cred.user.uid;
  await signOut(secondaryAuth);
  return { uid, email };
}

export async function changeOwnPassword(oldPw, newPw) {
  const u = auth.currentUser;
  await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, oldPw));
  await updatePassword(u, newPw);
}

export function logout() { return signOut(auth); }

export function errText(e) {
  const c = (e && e.code) || "";
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|no-account|invalid-login/.test(c)) return "帳號或密碼錯誤";
  if (/too-many-requests/.test(c)) return "嘗試次數太多，請稍後再試";
  if (/network-request-failed|unavailable/.test(c)) return "網路連線失敗，請檢查網路";
  if (/weak-password/.test(c)) return "密碼至少要 6 個字元";
  if (/requires-recent-login/.test(c)) return "請重新登入後再試";
  if (/permission-denied/.test(c)) return "沒有權限（請確認 Firestore 規則與 ADMIN_UID 設定）";
  if (/operation-not-allowed|admin-restricted-operation/.test(c)) return "Firebase 尚未開啟「電子郵件／密碼」登入，或關閉了註冊功能";
  return (e && e.message) || "發生錯誤";
}

export function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function toast(msg) {
  const old = document.querySelector(".toast"); if (old) old.remove();
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}

export function setupNotice(el) {
  el.innerHTML = '<div class="login-card"><h1>尚未完成設定</h1><p>請先在 <code>js/config.js</code> 填入 Firebase 設定與老師帳號 UID，步驟見 README.md。</p></div>';
}

export { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, deleteField };
