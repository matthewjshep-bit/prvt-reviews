import React from "react";
import { createRoot } from "react-dom/client";
import MessagingPage from "./MessagingPage.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MessagingPage />
  </React.StrictMode>
);
