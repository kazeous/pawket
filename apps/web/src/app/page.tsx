import Link from "next/link";
import { AppShell } from "../ui/app-shell";

export default function HomePage() {
  return (
    <AppShell action={{ href: "/sign-in", label: "Đăng nhập" }}>
      <section className="home-intro reveal">
        <div>
          <h1>Một góc làm việc cho nghệ sĩ.</h1>
          <p>Pawket đang mở từng phần một. Hiện tại bạn có thể quản lý tài khoản bảo mật và chuẩn bị hồ sơ nhà sáng tạo riêng tư.</p>
        </div>
        <div className="home-actions">
          <Link className="button-link" href="/creator/apply">Mở hồ sơ creator</Link>
          <Link className="text-link" href="/settings/security">Cài đặt bảo mật <span aria-hidden="true">→</span></Link>
        </div>
      </section>
      <section className="availability-strip" aria-label="Những phần đang khả dụng">
        <p><strong>Đang dùng được</strong><span>Tài khoản · bảo mật · hồ sơ creator</span></p>
        <p><strong>Chưa mở</strong><span>Trang công khai · commission · merchandise · tip</span></p>
      </section>
    </AppShell>
  );
}
