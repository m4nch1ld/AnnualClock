import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

const poppins = Poppins({ subsets: ["latin", "latin-ext"], weight: ["300", "400", "500", "600"], variable: "--font-poppins" });

export const metadata: Metadata = {
  title: { default: "Annual Clock · ESL Shipping", template: "%s · Annual Clock" },
  description: "Departmental annual clocks with reminders for recurring and regulatory work.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={poppins.variable}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
