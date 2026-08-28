// Floating menus opened at the pointer (context menus, chip menus). They all
// mount to <body> and then need clamping so a menu near an edge stays fully
// on screen.

const MARGIN = 8;

// Mount `menu` and place its top-left at (x, y), pulled back inside the
// viewport if that would overflow. Measure after mounting — an unmounted
// element has no size.
export function mountMenuAtPointer(menu, x, y) {
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(x, window.innerWidth - rect.width - MARGIN));
  const top = Math.max(MARGIN, Math.min(y, window.innerHeight - rect.height - MARGIN));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  return menu;
}
