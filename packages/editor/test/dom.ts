// jsdom has no layout; ProseMirror asks for rectangles when scrolling the selection into view.
const rects = () => Object.assign([], { item: () => null });
Range.prototype.getClientRects = rects as never;
Range.prototype.getBoundingClientRect = () => new DOMRect();
Element.prototype.getClientRects = rects as never;
document.elementFromPoint = () => null;
