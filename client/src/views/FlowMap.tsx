import { Fragment, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type FlowBadge,
  type FlowBotNode,
  type FlowDelivery,
  type FlowModel,
  type FlowSourceNode,
  buildFlow,
  edgePath,
  flowSourceName,
  relatedIds,
} from "../flow";
import { Link } from "../Link";
import type { Subscription } from "../../../src/api/types";
import type { FlowData } from "../load";

// The flow of events on the overview screen: sources → bots → destinations, and where it stops.
// Wide screens draw three columns with lines between the cards; phones list each bot with its sources and destination.
export function FlowMap({ data, unassigned = [] }: { data: FlowData; unassigned?: Subscription[] }) {
  // useId may contain characters that are awkward in url(#…) references.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const headingId = `${uid}-heading`;
  return (
    <section className="flow" aria-labelledby={headingId}>
      <div className="flow-head">
        <h2 id={headingId}>配信の流れ</h2>
        <p className="flow-legend">
          <span className="flow-legend-item">
            <span className="flow-legend-line" aria-hidden="true" />
            届く経路
          </span>
          <span className="flow-legend-item">
            <span className="flow-legend-line is-dashed" aria-hidden="true" />
            止まっている経路
          </span>
        </p>
      </div>
      <FlowContent data={data} collapsed={false} uid={uid} />
      {unassigned.length > 0 && (
        <div className="callout flow-orphans">
          <p className="warning-note">
            どの Bot にも割り当てられていない配信先には、イベントが届きません:{" "}
            {unassigned.map((subscription) => subscriptionName(subscription)).join("、")}
          </p>
          <Link to="/bots" className="button button-primary">
            Bot に割り当てる
          </Link>
        </div>
      )}
    </section>
  );
}

function FlowContent({ data, collapsed, uid }: { data: FlowData; collapsed: boolean; uid: string }) {
  const model = useMemo(() => buildFlow(data.sources, data.bots), [data]);

  if (model.sources.length === 0 && model.bots.length === 0) {
    return (
      <div className="flow-empty">
        <p>送信元と Bot を作ると、ここに配信の流れが表示されます。</p>
        <p className="flow-links">
          <Link to="/sources">送信元画面へ</Link>
          <Link to="/bots">Bot 画面へ</Link>
        </p>
      </div>
    );
  }
  return (
    <>
      <FlowDiagram model={model} collapsed={collapsed} uid={uid} />
      <FlowStack model={model} />
    </>
  );
}

function NoBots() {
  return (
    <p className="flow-empty-column">
      Bot がありません。<Link to="/bots">Bot 画面へ</Link>
    </p>
  );
}

function NoSources() {
  return (
    <p className="flow-empty-column">
      送信元がありません。<Link to="/sources">送信元画面へ</Link>
    </p>
  );
}

function Badges({ badges }: { badges: FlowBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="flow-badges">
      {badges.map((badge) => (
        <span key={badge.label} className={badge.tone === "warning" ? "badge badge-warning" : "badge badge-off"}>
          {badge.label}
        </span>
      ))}
    </span>
  );
}

function DeliveryBody({ delivery }: { delivery: FlowDelivery }) {
  return (
    <>
      <span className="flow-kind">{delivery.kindLabel}</span>
      {delivery.primary !== null && <span className="flow-name">{delivery.primary}</span>}
      {delivery.badge !== null && <Badges badges={[{ label: delivery.badge, tone: "warning" }]} />}
      {delivery.note !== null && <span className="flow-note">{delivery.note}</span>}
    </>
  );
}

// The three columns with the lines drawn over them. Hidden on phones.
function FlowDiagram({ model, collapsed, uid }: { model: FlowModel; collapsed: boolean; uid: string }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const related = useMemo(() => relatedIds(model, focused), [model, focused]);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const origin = canvas.getBoundingClientRect();
    // Not laid out: closed, or a phone, where the diagram is not shown.
    if (origin.width === 0) return;
    const next: Record<string, string> = {};
    // The lines that share a card are spread around its anchor, 12px apart, ordered by the height of their other ends,
    // so that they leave and enter without crossing each other at the card.
    const top = (id: string) => nodes.current.get(id)?.getBoundingClientRect().top ?? 0;
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    for (const edge of model.edges) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.id]);
      incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.id]);
    }
    const ends = new Map(model.edges.map((edge) => [edge.id, edge]));
    for (const ids of outgoing.values()) ids.sort((a, b) => top(ends.get(a)?.to ?? "") - top(ends.get(b)?.to ?? ""));
    for (const ids of incoming.values()) ids.sort((a, b) => top(ends.get(a)?.from ?? "") - top(ends.get(b)?.from ?? ""));
    const spread = (ids: string[] | undefined, id: string) => {
      if (ids === undefined || ids.length < 2) return 0;
      return (ids.indexOf(id) - (ids.length - 1) / 2) * 12;
    };
    for (const edge of model.edges) {
      const from = nodes.current.get(edge.from);
      const to = nodes.current.get(edge.to);
      if (from === undefined || to === undefined) continue;
      next[edge.id] = edgePath(
        from.getBoundingClientRect(),
        to.getBoundingClientRect(),
        origin,
        spread(outgoing.get(edge.from), edge.id),
        spread(incoming.get(edge.to), edge.id),
      );
    }
    setPaths(next);
  }, [model]);

  useLayoutEffect(() => {
    measure();
  }, [measure, collapsed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [measure]);

  function stateClass(id: string): string {
    if (focused === null) return "";
    return related.has(id) ? " is-on" : " is-dimmed";
  }

  // The wrapper of a card: measured for the lines, and the target of hover and focus (focus events bubble from the
  // link in it). A plain function, not a component, so that the cards are not mounted again on every render.
  function node(id: string, className: string | null, children: ReactNode) {
    return (
      <div
        key={id}
        ref={(el) => {
          if (el === null) nodes.current.delete(id);
          else nodes.current.set(id, el);
        }}
        className={`flow-node${className === null ? "" : ` ${className}`}${stateClass(id)}`}
        onMouseEnter={() => setFocused(id)}
        onMouseLeave={() => setFocused(null)}
        onFocus={() => setFocused(id)}
        onBlur={() => setFocused(null)}
      >
        {children}
      </div>
    );
  }

  const arrow = `${uid}-arrow`;
  const arrowOn = `${uid}-arrow-on`;

  return (
    <div className="flow-canvas" ref={canvasRef}>
      <div className="flow-grid">
        <h3 className="flow-column-head">送信元</h3>
        <h3 className="flow-column-head">Bot</h3>
        <h3 className="flow-column-head">配信先</h3>
        <div className="flow-sources">
          {model.sources.length === 0 && <NoSources />}
          {model.sources.map((source: FlowSourceNode) =>
            node(
              source.id,
              source.enabled ? null : "is-disabled",
              <Link to={`/sources/${source.sourceId}`} className="flow-card">
                <span className="flow-name">{source.name}</span>
                <Badges badges={source.badges} />
              </Link>,
            ),
          )}
        </div>
        <div className="flow-rows">
          {model.bots.length === 0 && <NoBots />}
          {model.bots.map((bot: FlowBotNode) => (
            <Fragment key={bot.id}>
              {node(
                bot.id,
                null,
                <Link to="/bots" className="flow-card">
                  <span className="flow-name">{bot.name}</span>
                  <Badges badges={bot.badges} />
                  <span className="sr-only">{bot.description}</span>
                </Link>,
              )}
              {node(
                bot.delivery.id,
                null,
                <Link to="/deliveries" className="flow-card">
                  <DeliveryBody delivery={bot.delivery} />
                </Link>,
              )}
            </Fragment>
          ))}
        </div>
      </div>
      <svg className="flow-lines" aria-hidden="true" focusable="false">
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" className="flow-arrow" />
          </marker>
          <marker id={arrowOn} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" className="flow-arrow is-on" />
          </marker>
        </defs>
        {model.edges.map((edge) => {
          const d = paths[edge.id];
          if (d === undefined) return null;
          const on = focused !== null && related.has(edge.id);
          return (
            <Fragment key={edge.id}>
              <path
                d={d}
                className={`flow-edge${edge.dashed ? " is-dashed" : ""}${stateClass(edge.id)}`}
                markerEnd={`url(#${on ? arrowOn : arrow})`}
              />
              {/* A dot that travels along the edges events take, to show the direction. Hidden when motion is
                  reduced (styles.css), since SMIL ignores the setting. */}
              {!edge.dashed && (
                <circle r="3" className={`flow-pulse${stateClass(edge.id)}`}>
                  <animateMotion dur="2.4s" repeatCount="indefinite" path={d} />
                </circle>
              )}
            </Fragment>
          );
        })}
      </svg>
    </div>
  );
}

// Phones: each bot with its sources above and its destination below.
function FlowStack({ model }: { model: FlowModel }) {
  const unlinked = model.sources.filter((source) => !source.linked);
  return (
    <div className="flow-stack">
      {model.sources.length === 0 && <NoSources />}
      {model.bots.length === 0 && <NoBots />}
      {model.bots.length > 0 && (
        <ul className="flow-stack-list">
          {model.bots.map((bot) => (
            <li key={bot.id} className="flow-stack-item">
              <ol className="flow-steps">
                <li className="flow-step">
                  <span className="flow-step-label">送信元</span>
                  <span className="flow-step-value">
                    {bot.sources.length === 0 ? (
                      <span className="badge badge-warning">送信元なし</span>
                    ) : (
                      // One inline run, so that the commas sit right after the names (the value is a flex row).
                      <span>
                        {bot.sources.map((source, index) => (
                          <Fragment key={source.id}>
                            {index > 0 && "、"}
                            <Link to={`/sources/${source.sourceId}`}>{flowSourceName(source)}</Link>
                          </Fragment>
                        ))}
                      </span>
                    )}
                  </span>
                </li>
                <li className="flow-step">
                  <span className="flow-step-label">Bot</span>
                  <span className="flow-step-value">
                    <Link to="/bots" className="flow-name">
                      {bot.name}
                    </Link>
                  </span>
                </li>
                <li className={`flow-step${bot.delivery.badge !== null ? " is-stopped" : ""}`}>
                  <span className="flow-step-label">配信先</span>
                  <span className="flow-step-value">
                    <span className="kind-chip">{bot.delivery.kindLabel}</span>
                    {bot.delivery.primary !== null && <Link to="/deliveries">{bot.delivery.primary}</Link>}
                    {bot.delivery.badge !== null && <span className="badge badge-warning">{bot.delivery.badge}</span>}
                  </span>
                  {bot.delivery.note !== null && <span className="flow-note">{bot.delivery.note}</span>}
                </li>
              </ol>
            </li>
          ))}
        </ul>
      )}
      {unlinked.length > 0 && (
        <div className="callout flow-unlinked">
          <p className="warning-note">
            <span>
              どの Bot にも届かない送信元:{" "}
              {unlinked.map((source, index) => (
                <Fragment key={source.id}>
                  {index > 0 && "、"}
                  <Link to={`/sources/${source.sourceId}`}>{flowSourceName(source)}</Link>
                </Fragment>
              ))}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

// A destination as the warning names it: its name, or the app of its connection, or its host.
function subscriptionName(subscription: Subscription): string {
  return (
    subscription.name ?? subscription.connection?.client_name ?? subscription.callback_host ?? subscription.id
  );
}
