import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Trellis Studio — Image to 3D", description: "A personal AI image-to-3D workstation." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
