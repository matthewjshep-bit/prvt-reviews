import React from "react";
import { createRoot } from "react-dom/client";
import HomePage from "./HomePage.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HomePage />
  </React.StrictMode>
);
