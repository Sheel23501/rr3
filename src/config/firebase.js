import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyD3jwJgKyOFc2ypsHkJK9TiUvSx6TPA_xA",
  authDomain: "trucare-76365.firebaseapp.com",
  databaseURL: "https://trucare-76365-default-rtdb.firebaseio.com",
  projectId: "trucare-76365",
  storageBucket: "trucare-76365.firebasestorage.app",
  messagingSenderId: "900286609052",
  appId: "1:900286609052:web:0e8f8820c7c5645c309f59",
  measurementId: "G-ZMC4N9PLZC"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export default app;
