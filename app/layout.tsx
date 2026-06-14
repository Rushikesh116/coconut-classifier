import type React from "react"
import type { Metadata } from "next"
import { Nunito } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"

const nunito = Nunito({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"], variable: "--font-nunito" })

export const metadata: Metadata = {
  title: "Coconut Grader - Food Quality Assessment",
  description: "Professional coconut quality grading system to assess food-grade standards",
  generator: "v0.app",
  icons: {
    icon: "/navbar-coconut.png",
    apple: "/navbar-coconut.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${nunito.variable} bg-background font-sans text-foreground antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
