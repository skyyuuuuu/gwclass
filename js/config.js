// ===== 部署前要改的設定（只有這個檔案和 firestore.rules 需要改）=====

// 1) Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → 「SDK 設定和配置」貼上這一段
export const firebaseConfig = {
  apiKey: "填入你的 apiKey",
  authDomain: "填入你的專案.firebaseapp.com",
  projectId: "填入你的專案 ID",
  storageBucket: "填入你的專案.firebasestorage.app",
  messagingSenderId: "填入",
  appId: "填入"
};

// 2) Firebase 主控台 → Authentication → 使用者 → 你自己（老師）帳號的「使用者 UID」
//    firestore.rules 裡也要填同一個 UID
export const ADMIN_UID = "填入老師帳號的 UID";

// ===== 以下通常不用改 =====
export const SCHOOL_NAME = "光武國中";
export const DEFAULT_CLASSES = ["701", "711"];
// 學生帳號在系統內部使用的 Email 網域（不會真的寄信，家長也看不到）
export const LOGIN_DOMAIN = "students.example.com";
