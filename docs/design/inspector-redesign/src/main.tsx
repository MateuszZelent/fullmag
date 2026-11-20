import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="fullmag-inspector-theme">
      <TooltipProvider delayDuration={250}>
        <App />
        <Toaster position="bottom-center" />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)
