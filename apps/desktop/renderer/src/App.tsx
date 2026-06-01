import { Workspace } from "./browser/Workspace";
import { TitleBar } from "./components/TitleBar";

export function App() {
  return (
    // The canvas — deep charcoal, with the card floating inside a small inset.
    <div className="flex h-full w-full bg-canvas p-4">
      {/* The single floating card. Everything lives inside it. */}
      <div className="flex h-full w-full flex-col overflow-hidden rounded-card bg-card shadow-card">
        <TitleBar />
        <main className="min-h-0 flex-1">
          <Workspace />
        </main>
      </div>
    </div>
  );
}
