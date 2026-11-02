// ============================================================
//  Firebase 설정 파일 — 이 파일만 내 프로젝트 값으로 바꾸면 됩니다.
//  Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹) > "SDK 설정 및 구성"의
//  firebaseConfig 값을 그대로 복사해 아래에 붙여 넣으세요.
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyArshNp67vnUmmkf7wlhBNnFMmN8-QR7g0",
  authDomain: "moral-practice.firebaseapp.com",
  projectId: "moral-practice",
  storageBucket: "moral-practice.firebasestorage.app",
  messagingSenderId: "435907599795",
  appId: "1:435907599795:web:373dc5a92b12dc17843fc6"
};

// 교사 계정 이메일 (Firebase 콘솔 > Authentication 에서 만든 교사 계정)
// ※ firestore.rules 파일 맨 위의 이메일과 반드시 똑같아야 합니다.
export const TEACHER_EMAIL = "pwoong99@naver.com";

// 화면에 표시할 학급 이름
export const CLASS_NAME = "5학년 4반";
