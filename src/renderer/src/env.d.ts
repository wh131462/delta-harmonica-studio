/**
 * 渲染进程全局类型：
 * - window.api 由 preload 注入
 * - 兼容 React 19 移除全局 JSX 命名空间后的写法（本项目仍使用 JSX.Element 标注）
 */
import type { JSX as ReactJSX } from 'react';
import type { RendererApi } from '@shared/types';

declare global {
  interface Window {
    api: RendererApi;
  }
  namespace JSX {
    interface Element extends ReactJSX.Element {}
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}

export {};

