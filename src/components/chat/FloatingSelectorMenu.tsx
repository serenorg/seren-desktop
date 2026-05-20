// ABOUTME: Portal-backed floating menu for compact composer selectors.
// ABOUTME: Keeps dropdowns visible when their toolbar row scrolls horizontally.

import type { Component, JSX } from "solid-js";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { FLOATING_SELECTOR_MENU_BASE_CLASSES } from "@/components/chat/floatingSelectorMenuClasses";

interface Props {
  open: boolean;
  anchor: () => HTMLElement | undefined;
  class?: string;
  onRequestClose: () => void;
  children: JSX.Element;
}

export const FloatingSelectorMenu: Component<Props> = (props) => {
  const [style, setStyle] = createSignal<JSX.CSSProperties>({});
  let menuRef: HTMLDivElement | undefined;

  const updatePosition = () => {
    const anchor = props.anchor();
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menuRef?.getBoundingClientRect();
    const menuWidth = menuRect?.width ?? anchorRect.width;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gutter = 8;
    const left = Math.max(
      gutter,
      Math.min(anchorRect.left, viewportWidth - menuWidth - gutter),
    );
    const bottom = Math.max(gutter, viewportHeight - anchorRect.top + 6);

    setStyle({
      left: `${left}px`,
      bottom: `${bottom}px`,
    });
  };

  createEffect(() => {
    if (!props.open) return;

    updatePosition();
    const raf = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    onCleanup(() => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    });
  });

  createEffect(() => {
    if (!props.open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (props.anchor()?.contains(target) || menuRef?.contains(target)) return;
      props.onRequestClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    onCleanup(() => {
      document.removeEventListener("mousedown", handlePointerDown);
    });
  });

  return (
    <Show when={props.open}>
      <Portal mount={document.body}>
        <div
          ref={menuRef}
          class={`${FLOATING_SELECTOR_MENU_BASE_CLASSES} ${props.class ?? ""}`}
          style={style()}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
};
