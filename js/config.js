// ===== 部署前要改的設定（只有這個檔案和 firestore.rules 需要改）=====

// 1) Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → 「SDK 設定和配置」貼上這一段
export const firebaseConfig = {
  apiKey: "AIzaSyDY6-tcxTuN2Qa9tD1aDe1BLo1UORzxcCU",
  authDomain: "gwclass.firebaseapp.com",
  projectId: "gwclass",
  storageBucket: "gwclass.firebasestorage.app",
  messagingSenderId: "1037793920070",
  appId: "1:1037793920070:web:b75573f2145d2ca534f647"
};

// 2) Firebase 主控台 → Authentication → 使用者 → 你自己（老師）帳號的「使用者 UID」
//    firestore.rules 裡也要填同一個 UID
export const ADMIN_UID = "n9AzFb2aWVYZiK3OO78tHaVlzBy2";

// ===== 以下通常不用改 =====
export const SCHOOL_NAME = "光武國中";
export const DEFAULT_CLASSES = ["701", "711"];
// 學生帳號在系統內部使用的 Email 網域（不會真的寄信，家長也看不到）
export const LOGIN_DOMAIN = "students.example.com";
