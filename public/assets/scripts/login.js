window.addEventListener("load", function () {
      const spinner = document.getElementById("spinner");
      const content = document.getElementById("content");
      setTimeout(() => {
          document.body.classList.remove("loading");
          document.body.classList.add("loaded");
          content.classList.add("loaded");
          spinner.style.opacity = 0;
      }, 1500);
  });

  document.getElementById("togglePassword").onclick = function () {
      const passwordField = document.getElementById("password");
      if (passwordField.type === "password") {
          passwordField.type = "text";
          this.classList.add("fa-eye-slash");
          this.classList.remove("fa-eye");
      } else {
          passwordField.type = "password";
          this.classList.add("fa-eye");
          this.classList.remove("fa-eye-slash");
      }
  };

  document.getElementById("loginForm").onsubmit = function (event) {
      event.preventDefault();

      var password = document.getElementById("password").value;

      var requestData = { password: password };

      fetch("/login", {
          method: "POST",
          headers: {
              "Content-Type": "application/json",
          },
          body: JSON.stringify(requestData),
      })
          .then((response) => {
              if (response.ok) {
                  window.location.href = "/";
              }
              if (response.status === 401) {
                  return "Invalid Password";
              }
              if (response.status === 429) {
                  return "Too many login attempts. Please try again later.";
              }
          })
          .then((errorMessage) => {
              if (errorMessage) {
                  document.getElementById("message").textContent = errorMessage;
              }
          })
          .catch((error) => {
              console.error("Login request failed:", error);
              document.getElementById("message").textContent =
                  "Something went wrong. Please try again later.";
          });
  };
