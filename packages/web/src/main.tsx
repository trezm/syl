import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ProjectProvider } from "./projects/ProjectContext";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Nothing below here renders until a project is chosen, so every request
        the app makes already knows which checkout it is about. */}
    <ProjectProvider>
      <App />
    </ProjectProvider>
  </React.StrictMode>
);
