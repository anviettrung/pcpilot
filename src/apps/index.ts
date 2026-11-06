// Danh sách app PcPilot. App đầu tiên là mặc định. Thêm app mới: tạo tệp trong src/apps/ (app chụp theo cửa sổ thì
// chỉ cần một khai báo WindowApp, xem src/apps/window-app.ts), thêm vào đây, rồi thêm phần giao diện trong web/apps/index.ts.
import { DesktopApp } from './desktop';
import type { App } from './types';
import { UnityApp } from './unity';

export const APPS: App[] = [new DesktopApp(), new UnityApp()];
