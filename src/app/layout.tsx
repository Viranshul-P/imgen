import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PersonaForge Studio",
  description: "Local amateur-phone-realism studio for a fictional AI character (ComfyUI on an 8 GB GPU).",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
