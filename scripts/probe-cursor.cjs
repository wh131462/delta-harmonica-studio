const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *rect)');

// 形式 A：对象直接传
const ptA = {};
try { console.log('A ret', GetCursorPos(ptA), 'ptA', ptA); } catch (e) { console.log('A error', e.message); }
// 形式 B：单元素数组
const ptB = [{}];
try { console.log('B ret', GetCursorPos(ptB), 'ptB', ptB); } catch (e) { console.log('B error', e.message); }
// 形式 C：预填对象
const ptC = { x: 0, y: 0 };
try { console.log('C ret', GetCursorPos(ptC), 'ptC', ptC); } catch (e) { console.log('C error', e.message); }
const hwnd = GetForegroundWindow();
const rect = {};
try { console.log('rect ret', GetWindowRect(hwnd, rect), 'rect', rect); } catch (e) { console.log('rect error', e.message); }
try { console.log('set cursor', SetCursorPos(500, 500)); const p = {}; GetCursorPos(p); console.log('after', p); } catch (e) { console.log('set error', e.message); }
