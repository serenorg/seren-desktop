// ABOUTME: Reusable context menu component for right-click actions.
// ABOUTME: Renders a menu at a specified position with customizable menu items.

import { createSignal, For, Show, onCleanup, createEffect, type Component } from "solid-js";
import "./ContextMenu.css";

export interface ContextMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  let menuRef: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal({ x: props.x, y: props.y });

  // Adjust position to keep menu within viewport
  createEffect(() => {
    if (!menuRef) return;

    const rect = menuRef.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = props.x;
    let y = props.y;

    // Adjust if menu would overflow right edge
    if (x + rect.width > viewportWidth) {
      x = viewportWidth - rect.width - 8;
    }

    // Adjust if menu would overflow bottom edge
    if (y + rect.height > viewportHeight) {
      y = viewportHeight - rect.height - 8;
    }

    // Ensure menu doesn't go off the left or top
    x = Math.max(8, x);
    y = Math.max(8, y);

    setPosition({ x, y });
  });

  // Close on click outside
  const handleClickOutside = (e: MouseEvent) => {
    if (menuRef && !menuRef.contains(e.target as Node)) {
      props.onClose();
    }
  };

  // Close on escape key
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    }
  };

  createEffect(() => {
    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    // Also close on scroll
    document.addEventListener("scroll", props.onClose, true);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleClickOutside);
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("scroll", props.onClose, true);
  });

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.disabled) return;
    item.onClick();
    props.onClose();
  };

  return (
    <div
      ref={menuRef}
      class="context-menu"
      style={{
        left: `${position().x}px`,
        top: `${position().y}px`,
      }}
      role="menu"
      aria-label="Context menu"
    >
      <For each={props.items}>
        {(item) => (
          <Show
            when={!item.separator}
            fallback={<div class="context-menu-separator" role="separator" />}
          >
            <button
              type="button"
              class="context-menu-item"
              classList={{ disabled: item.disabled }}
              onClick={() => handleItemClick(item)}
              role="menuitem"
              disabled={item.disabled}
            >
              <Show when={item.icon}>
                <span class="context-menu-icon">{item.icon}</span>
              </Show>
              <span class="context-menu-label">{item.label}</span>
            </button>
          </Show>
        )}
      </For>
    </div>
  );
};

export default ContextMenu;
