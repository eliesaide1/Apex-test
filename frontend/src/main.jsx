import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import Login from "./pages/Login.jsx";
import Exam from "./pages/Exam.jsx";
import Result from "./pages/Result.jsx";
import ProctorDashboard from "./pages/ProctorDashboard.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/exam" element={<Exam />} />
        <Route path="/result" element={<Result />} />
        <Route path="/proctor" element={<ProctorDashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
