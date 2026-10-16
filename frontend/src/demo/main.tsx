import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './demo.css'
import Demo from './Demo'
import Studio from './studio/Studio'

// The studio is the product; ?classic keeps the scripted pitch-video demo.
const classic = new URLSearchParams(location.search).has('classic')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {classic ? <Demo /> : <Studio />}
  </StrictMode>,
)
