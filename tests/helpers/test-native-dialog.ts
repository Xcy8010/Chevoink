export function mockNativeDialog() {
  const prototype = HTMLDialogElement.prototype
  const originals = {
    showModal: Object.getOwnPropertyDescriptor(prototype, 'showModal'),
    close: Object.getOwnPropertyDescriptor(prototype, 'close'),
  }
  Object.defineProperties(prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } },
  })
  return () => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(prototype, name, descriptor)
      else Reflect.deleteProperty(prototype, name)
    }
  }
}
