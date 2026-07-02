import { Outlet, useLocation } from "react-router-dom"

import { AppSidebar } from "@/components/app-sidebar"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

const TITLES: Record<string, string> = {
  "/": "Overview",
  "/instances": "Instances",
  "/inspector": "Decision Inspector",
  "/analysis": "Trade Analysis",
  "/cache": "Data Cache",
}

function titleFor(pathname: string): string {
  if (pathname.startsWith("/inspector")) return TITLES["/inspector"]
  return TITLES[pathname] ?? "Trading Console"
}

export function Layout() {
  const { pathname } = useLocation()
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="text-sm font-medium">{titleFor(pathname)}</span>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
