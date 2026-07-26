import React from "react";
import { createRoot } from "react-dom/client";
import OfferApp from "./OfferApp.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <OfferApp />
  </React.StrictMode>
);
