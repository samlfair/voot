function clientScript() {
  const clientScript = `
  <script>
    function openSocket() {
      console.log("Socket opened")
      const socket = new WebSocket('ws://localhost:8000');
      socket.addEventListener('open', () => {
        socket.send('opened')

      });


      socket.addEventListener("close", () => {
        console.log("Socket closed")
        socket.close()
        setTimeout(() => {
          console.log("socket closed refresh")
          location.reload()

        }, 1000)
      })

      function isOpen() {
        return socket.readyState === 1
      }

      socket.addEventListener('message', e => {
        const data = JSON.parse(e.data)
        if(data.message === "refresh" && isOpen()) {
          if(data.payload) {
            const regex = new RegExp(window.location.pathname + "(index)?(\.html)")
            if(!data.payload.path.match(regex)) return
            const body = document.querySelector("body")
            const newBody = document.createElement("body")
            const content = data.payload.data.match(/<body.*?>([\\s\\S]*)<.body>/)
            newBody.innerHTML = content[1]
            body.replaceChildren(...newBody.children)
          } else {
            location.reload()
          }
        } else if(data.message === "styles" && isOpen()) {
          const stylesheet = document.querySelector("link[href*='styles.css']")
          stylesheet.setAttribute("href", "/styles.css?" + Date.now())
        }
      });
    }

    openSocket()
  </script>`

  return clientScript
}

export default clientScript

