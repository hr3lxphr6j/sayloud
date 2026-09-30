/**
 * Whether the browser can open a Document Picture-in-Picture window.
 *
 * Chrome 116 added the API, and it is a web API rather than an extension one,
 * so every context of the same browser gives the same answer: the content
 * script asks before it shows the bar's caption button, and the side panel asks
 * before it promises, in the settings, that the switch will do something.
 *
 * Kept out of `CaptionWindow` so the side panel can ask without pulling Preact
 * and the whole caption view into its bundle.
 */
export function supportsPictureInPicture(scope: Window = window): boolean {
  return 'documentPictureInPicture' in scope;
}
