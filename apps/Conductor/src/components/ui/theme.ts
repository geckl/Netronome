import { Button, createSystem, defaultConfig } from "@chakra-ui/react"

export const system = createSystem(defaultConfig, {
  theme: {
    tokens: {
      fonts: {
        heading: { value: `'Figtree', sans-serif` },
        body: { value: `'Figtree', sans-serif` },
      },
      colors: {
        brand: {
          50: { value: '#dafbff'},
          100: { value: '#aeefff'},
          200: { value: '#80e2fd'},
          300: { value: '#51d6fb'},
          400: { value: '#29cbf8'},
          500: { value: '#18b1df'},
          600: { value: '#048aae'},
          700: { value: '#00627d'},
          800: { value: '#003c4e'},
          900: { value: '#00161e'},
        },
      },
      },
    },
})



