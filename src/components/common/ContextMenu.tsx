// ABOUTME: Reusable context menu component for right-click actions.
// ABOUTME: Renders a menu at a specified position with customizable menu items.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";

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
      class="fixed z-[10000] min-w-[180px] bg-[#1c2128] border border-[#30363d] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)] animate-[context-menu-appear_0.1s_ease-out]"
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
            fallback={
              <div class="h-px bg-[#30363d] my-1 mx-2" role="separator" />
            }
          >
            <button
              type="button"
              class={`flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-[#e6edf3] text-[13px] text-left cursor-pointer transition-colors duration-100 focus:outline-none focus:bg-[#30363d] focus-visible:outline-2 focus-visible:outline-[#58a6ff] focus-visible:outline-offset-[-2px] ${
                item.disabled
                  ? "text-[#6e7681] cursor-not-allowed"
                  : "hover:bg-[#30363d] active:bg-[#3d444d]"
              }`}
              onClick={() => handleItemClick(item)}
              role="menuitem"
              disabled={item.disabled}
            >
              <Show when={item.icon}>
                <span class="w-4 text-center text-sm">{item.icon}</span>
              </Show>
              <span class="flex-1">{item.label}</span>
            </button>
          </Show>
        )}
      </For>
    </div>
  );
};

export default ContextMenu;
