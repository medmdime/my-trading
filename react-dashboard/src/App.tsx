import { Route, Routes } from "react-router-dom"

import { Layout } from "@/components/Layout"
import { Analysis } from "@/pages/Analysis"
import { Controllers } from "@/pages/Controllers"
import { Home } from "@/pages/Home"
import { Deploy } from "@/pages/Deploy"
import { Inspector } from "@/pages/Inspector"
import { Instances } from "@/pages/Instances"
import { Optimize } from "@/pages/Optimize"

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="controllers" element={<Controllers />} />
        <Route path="optimize" element={<Optimize />} />
        <Route path="deploy" element={<Deploy />} />
        <Route path="instances" element={<Instances />} />
        <Route path="inspector" element={<Inspector />} />
        <Route path="inspector/:botName" element={<Inspector />} />
        <Route path="analysis" element={<Analysis />} />
      </Route>
    </Routes>
  )
}

export default App
