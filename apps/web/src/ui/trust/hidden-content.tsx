import { StatusBanner } from "@/ui/status-banner";

export function HiddenContent({ kind }: Readonly<{ kind: "message" | "file" }>) {
  return <StatusBanner>{kind === "message" ? "Tin nhắn này đã bị Pawket ẩn vì vi phạm quy định cộng đồng." : "Tệp này đã bị Pawket ẩn vì vi phạm quy định cộng đồng."}</StatusBanner>;
}
