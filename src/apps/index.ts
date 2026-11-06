// Danh sách app UnityPilot. App đầu tiên là mặc định. Thêm app mới: tạo tệp trong src/apps/ theo giao diện App
// (src/apps/types.ts), thêm vào đây, rồi thêm phần giao diện trong web/apps/index.ts.
import type { App } from './types';
import { UnityApp } from './unity';

export const APPS: App[] = [new UnityApp()];
