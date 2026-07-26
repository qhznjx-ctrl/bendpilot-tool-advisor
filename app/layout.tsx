import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title: "BendPilot — 折弯模具智能选型",
    description:
      "面向钣金工程师的二维折弯分析、模具推荐与碰撞检查工作台。",
    openGraph: {
      title: "BendPilot — 折弯模具智能选型",
      description: "二维建模、模具推荐、碰撞检测与自动消碰。",
      type: "website",
      images: [{ url: imageUrl, width: 1730, height: 909, alt: "BendPilot 折弯模具智能选型" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "BendPilot — 折弯模具智能选型",
      description: "二维建模、模具推荐、碰撞检测与自动消碰。",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
