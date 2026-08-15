import Link from 'next/link';
import {
  IconShield,
  IconAlertTriangle,
  IconHeartOff,
  IconChevronRight,
  IconCircleCheck,
  IconUser,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ActionRequiredProps {
  pendingApprovals: number;
  blockedTasks: number;
  staleAgents: number;
  humanTasks?: number;
}

interface ActionItem {
  icon: React.ReactNode;
  /** Singular phrase, used when count === 1. */
  label: string;
  /**
   * Plural phrase, used for every other count. Spelled out rather than
   * derived by suffixing an 's': the noun is not always the last word
   * ("task assigned to you" pluralised to "task assigned to yous").
   */
  plural: string;
  count: number;
  href: string;
}

export function ActionRequired({
  pendingApprovals,
  blockedTasks,
  staleAgents,
  humanTasks = 0,
}: ActionRequiredProps) {
  const totalActions = pendingApprovals + blockedTasks + staleAgents + humanTasks;

  const items: ActionItem[] = [
    {
      icon: <IconUser size={18} className="text-primary" />,
      label: 'task assigned to you',
      plural: 'tasks assigned to you',
      count: humanTasks,
      href: '/tasks?agent=human',
    },
    {
      icon: <IconShield size={18} className="text-primary" />,
      label: 'pending approval',
      plural: 'pending approvals',
      count: pendingApprovals,
      href: '/approvals',
    },
    {
      icon: <IconAlertTriangle size={18} className="text-warning" />,
      label: 'blocked task',
      plural: 'blocked tasks',
      count: blockedTasks,
      href: '/tasks?status=blocked',
    },
    {
      icon: <IconHeartOff size={18} className="text-destructive" />,
      label: 'stale agent',
      plural: 'stale agents',
      count: staleAgents,
      href: '/agents',
    },
  ];

  return (
    <Card className="bg-muted/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Action Required
        </CardTitle>
      </CardHeader>
      <CardContent>
        {totalActions === 0 ? (
          <div className="flex items-center gap-2 text-muted-foreground py-1">
            <IconCircleCheck size={18} className="text-success" />
            <span className="text-sm">All clear - nothing needs your attention</span>
          </div>
        ) : (
          <div className="space-y-1">
            {items
              .filter((item) => item.count > 0)
              .map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    {item.icon}
                    <span className="text-sm">
                      <span className="font-semibold">{item.count}</span>{' '}
                      {item.count === 1 ? item.label : item.plural}
                    </span>
                  </div>
                  <IconChevronRight
                    size={16}
                    className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </Link>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
