/**
 * src/ui/dom.ts
 *
 * Contents: tiny DOM construction and mutation helpers used by every WS7 UI module — `el` / `svgEl`
 * for building trees without innerHTML, and `setText` / `setProp` / `setAttr`, which write only when
 * the value actually changed.
 *
 * Purpose: the HUD is rewritten every frame's worth of data but must cost < 0.3 ms. The single most
 * effective trick is to never touch the DOM when nothing changed: an unchanged `textContent`
 * assignment still dirties the node and invalidates layout for that subtree. Reading `textContent`
 * or `style.getPropertyValue` first is cheap (no forced reflow, both are already-computed author
 * values), so the compare-then-write pattern here is a strict win.
 *
 * Ownership: WS7. No other workstream should need these.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an HTML element, optionally class it and append it.
 *
 * @param tag - HTML tag name
 * @param className - space-separated class list, or undefined
 * @param parent - node to append to, or undefined to leave detached
 * @returns the created element, correctly typed for `tag`
 *
 * @complexity Time: O(1) | Space: O(1)
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Node,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

/**
 * Create an SVG element. `className` goes through `setAttribute` because SVG elements have a
 * read-only `SVGAnimatedString` `className` property.
 *
 * @complexity Time: O(1) | Space: O(1)
 */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Node,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  parent?.appendChild(node);
  return node;
}

/**
 * Set `textContent` only if it differs.
 *
 * @complexity Time: O(1) amortised | Space: O(1)
 */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * Set an inline CSS property (or custom property) only if it differs.
 *
 * @param node - target element
 * @param prop - CSS property name, e.g. `transform` or `--fill`
 * @param value - the value to write
 *
 * @complexity Time: O(1) | Space: O(1)
 */
export function setProp(node: HTMLElement | SVGElement, prop: string, value: string): void {
  if (node.style.getPropertyValue(prop) !== value) node.style.setProperty(prop, value);
}

/**
 * Set an attribute only if it differs.
 *
 * @complexity Time: O(1) | Space: O(1)
 */
export function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/** Toggle a class without reading/writing when the state is already correct. */
export function setClass(node: Element, className: string, on: boolean): void {
  if (node.classList.contains(className) !== on) node.classList.toggle(className, on);
}
