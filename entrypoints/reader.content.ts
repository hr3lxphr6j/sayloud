export default defineContentScript({
  registration: 'runtime',
  main() {
    console.log('[Content] SayLoud reader loaded');
  },
});
