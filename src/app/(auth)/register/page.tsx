import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "创建账号" };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
