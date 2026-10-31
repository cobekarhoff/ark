// Connects to the hub's SSE stream. The hub-ui step replaces this file with the React app.
const root = document.getElementById("root")!;
const events = new EventSource("/api/events");
events.onmessage = (message) => {
  root.textContent = JSON.stringify(JSON.parse(message.data), null, 2);
};
