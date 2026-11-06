// Danh sách app trên trang, cùng id với src/apps/index.ts. App đầu tiên là mặc định.
// App mới: viết một WebApp (web/core.ts) trong web/apps/ rồi thêm vào đây.
import type { WebApp } from '../core';
import { unityApp } from './unity';

export const WEB_APPS: WebApp[] = [unityApp];
