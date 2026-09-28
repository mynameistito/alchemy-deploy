export default {
  fetch() {
    return new Response("Preview removed", { status: 410 });
  },
};
