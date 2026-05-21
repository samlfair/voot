export default function openSocket() {
  console.info("Socket opened")
  const socket = new WebSocket('ws://localhost:8000');
  socket.addEventListener('open', () => {
    socket.send('opened')
  });


  socket.addEventListener("close", () => {
    console.info("Socket closed")
    socket.close()
    setTimeout(() => {
      console.info("socket closed refresh")
      location.reload()

    }, 1000)
  })

  function isOpen() {
    return socket.readyState === 1
  }

  socket.addEventListener('message', e => {
    const data = JSON.parse(e.data)
    console.log(data)
    if (data.message === "filechange" && isOpen()) {
      if (data.payload) {
        const regex = new RegExp(window.location.pathname + "(index)?(\.html)")
        if (!data.payload.path.match(regex)) return

        const parser = new DOMParser()
        const oldHead = parser.parseFromString(document.documentElement.outerHTML, "text/html").head.innerHTML
        const newHead = parser.parseFromString(data.payload.data, "text/html").head.innerHTML

        // if (false) {
          if(oldHead !== newHead) {
          location.reload()
        } else {
          const body = document.querySelector("body")
          const newBody = document.createElement("body")
          const content = data.payload.data.match(/<body.*?>([\\s\\S]*)/)
          newBody.innerHTML = content[1]
          body.replaceWith(newBody)
        }
      } else {
        location.reload()
      }
    }
  });
}