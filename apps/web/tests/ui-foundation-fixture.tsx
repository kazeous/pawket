// Browser-only fixture bundled by the test harness; never a product route.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InfoIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function FoundationFixture() {
  const [choices, setChoices] = useState<string[]>(["a"]);
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-4">
      <h1>Nền giao diện Pawket</h1>
      <Card>
        <CardHeader>
          <CardTitle>Biểu mẫu thử nghiệm</CardTitle>
          <CardDescription>Dữ liệu tổng hợp, không gửi yêu cầu thanh toán.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="fixture-name">Tên hiển thị</FieldLabel>
              <Input id="fixture-name" placeholder="Tên của bạn" />
            </Field>
            <Field data-invalid>
              <FieldLabel htmlFor="fixture-amount">Giá trị thử nghiệm</FieldLabel>
              <InputGroup>
                <InputGroupInput id="fixture-amount" aria-invalid aria-describedby="fixture-error" defaultValue="0" />
                <InputGroupAddon align="inline-end"><InputGroupText>VND</InputGroupText></InputGroupAddon>
              </InputGroup>
              <FieldError id="fixture-error">Nhập một số nguyên dương.</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="fixture-message">Lời nhắn</FieldLabel>
              <Textarea id="fixture-message" aria-describedby="fixture-hint" />
              <FieldDescription id="fixture-hint">Nội dung thử nghiệm.</FieldDescription>
            </Field>
          </FieldGroup>
          <ToggleGroup aria-label="Chọn mẫu" value={choices} onValueChange={setChoices} variant="outline">
            <ToggleGroupItem value="a">Mẫu A</ToggleGroupItem>
            <ToggleGroupItem value="b">Mẫu B</ToggleGroupItem>
            <ToggleGroupItem value="c">Mẫu C</ToggleGroupItem>
          </ToggleGroup>
          <Alert><InfoIcon /><AlertTitle>Chế độ thử nghiệm</AlertTitle><AlertDescription>Không có giao dịch thật.</AlertDescription></Alert>
          <Badge variant="secondary">Chưa thực hiện</Badge>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <AlertDialog>
            <AlertDialogTrigger render={<Button />}>Xem hộp thoại</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Kiểm tra bằng bàn phím</AlertDialogTitle>
                <AlertDialogDescription>Hộp thoại thử nghiệm giữ tiêu điểm và trả về nút mở khi đóng.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Đóng thử nghiệm</AlertDialogCancel></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button disabled><Spinner data-icon="inline-start" />Đang xử lý</Button>
        </CardFooter>
      </Card>
      <Separator />
      <Table>
        <TableCaption>Bảng thử nghiệm</TableCaption>
        <TableHeader><TableRow><TableHead>Mục</TableHead><TableHead>Trạng thái</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>Mẫu tổng hợp</TableCell><TableCell>Đang chờ</TableCell></TableRow></TableBody>
      </Table>
      <Empty><EmptyHeader><EmptyTitle>Chưa có dữ liệu</EmptyTitle><EmptyDescription>Dữ liệu sẽ hiển thị tại đây.</EmptyDescription></EmptyHeader></Empty>
      <Skeleton className="h-4 w-full" aria-hidden />
    </main>
  );
}

createRoot(document.getElementById("fixture")!).render(<FoundationFixture />);
