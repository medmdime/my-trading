import * as React from "react"
import { Link, useLocation } from "react-router-dom"
import { Boxes, Home, LineChart, Radio } from "lucide-react"

import { IS_LIVE, TARGET_LABEL } from "@/lib/env"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

const NAV = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/instances", label: "Instances", icon: Boxes, end: false },
  { to: "/inspector", label: "Decision Inspector", icon: Radio, end: false },
  { to: "/analysis", label: "Trade Analysis", icon: LineChart, end: false },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { pathname } = useLocation()
  const isActive = (to: string, end: boolean) =>
    end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1.5">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-base">
            🐧
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-semibold">Trading Console</span>
            <span className="truncate text-xs text-muted-foreground">Hummingbot</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Monitor</SidebarGroupLabel>
          <SidebarMenu>
            {NAV.map((item) => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive(item.to, item.end)}
                  tooltip={item.label}
                >
                  <Link to={item.to}>
                    <item.icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs group-data-[collapsible=icon]:justify-center">
          <span
            className={`size-2 shrink-0 rounded-full ${IS_LIVE ? "bg-red-500" : "bg-emerald-500"}`}
          />
          <span className="truncate text-muted-foreground group-data-[collapsible=icon]:hidden">
            {TARGET_LABEL}
          </span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
