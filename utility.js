
import { Kafka, Partitioners } from 'kafkajs';
import { exec } from 'node:child_process';
import fs from 'node:fs';

export function get_latest_tbm_data() {
    const gtfsRealtimeCommand = `gtfs-realtime https://bdx.mecatran.com/utw/ws/gtfsfeed/vehicles/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt --output tbm.json`
    exec(gtfsRealtimeCommand, (error) => {
        if (error) {
            console.error(`Error executing command: ${error}`);
            return;
        }
    });
    if(fs.existsSync('tbm.json')) {
        let rawdata = fs.readFileSync('tbm.json');
        return JSON.parse(rawdata);
    }
}

export async function process_tbm_data() {
  try {
    const firstTBMJson = await get_latest_tbm_data();
    await sleep(1000);
    const secondTBMJson = await get_latest_tbm_data();
    const areDifferentJson = secondTBMJson.header.timestamp - firstTBMJson.header.timestamp > 0;
    if (!areDifferentJson) { return undefined }
    // console.log("------------------------------------MOYEN--------------------------------------");
    let averages = await get_stop_station_average_duration(firstTBMJson.entity, secondTBMJson.entity) 
    // console.log("averages : ", averages)
    // console.log("------------------------------------PANNES--------------------------------------");
    let failures = await get_actual_vehicle_failures(firstTBMJson.entity, secondTBMJson.entity)
    // console.log(failures)
    // console.log("-------------------------------------ROUTES-------------------------------------");
    let top_5_routes = await get_top_routes(secondTBMJson.entity,5)
    // console.log(top_5_routes)
    // console.log("-------------------------------------DELAI--------------------------------------");
    let vehicles_stop_duration = await get_vehicles_stop_duration(firstTBMJson.entity, secondTBMJson.entity)
    // console.log(vehicles_stop_duration)

    return {averages: averages, failuers: failures, top_5_routes: top_5_routes, vehicles_stop_duration: vehicles_stop_duration}
  } catch (error) {
    console.error(error);
  }
}

export async function get_stop_station_average_duration(vehicles_1,vehicles_2){
  for (const vehicle_1 of vehicles_1) {
    for (const vehicle_2 of vehicles_2) {
      if (
        vehicle_1.vehicle.vehicle.id == vehicle_2.vehicle.vehicle.id &&
        vehicle_1.vehicle.currentStatus == "STOPPED_AT" &&
        vehicle_2.vehicle.currentStatus == "IN_TRANSIT_TO"
      ) {
        const routeId = vehicle_1.vehicle.trip.routeId;
        const stopId = vehicle_1.vehicle.stopId;
        const directionId = vehicle_1.vehicle.trip.directionId;

        // const stop = await fetch(
        //       `https://ws.infotbm.com/ws/1.0/network/line-informations/${routeId}`
        //   );
        // const stopJson = await stop.json();

        // const fullLabel = stopJson.routes[directionId].stopPoints.find(
        //       stopPoint => stopPoint.externalCode === stopId
        //     ).fullLabel;

        const stopInfo=await get_stop_info_by_route_id_and_stop_id(routeId, stopId)
        
        if (stopInfo !== undefined) {

           let object ={
            routeId: routeId,
            stopId: stopId,
            stopDuration: vehicle_2.vehicle.timestamp - vehicle_1.vehicle.timestamp,
            timestamp: vehicle_2.vehicle.timestamp,
            fullLabel: stopInfo.fullLabel,
            vehicleType : vehicle_1.vehicle.vehicle.id.includes("bus") ? "BUS" : "TRAM",
            stopName: stopInfo.name,
            direction: vehicle_1.vehicle.vehicle.label,
            directionId: vehicle_1.vehicle.trip.directionId
          }

          return object
        }
        return undefined;
      }
    }
  }

}

export async function get_vehicles_stop_duration(vehicles_1, vehicles_2, detect_failures = false){
	let vehicles_stop_duration = []
	for (const vehicle_1 of vehicles_1) {
		for (const vehicle_2 of vehicles_2) {
			if(detect_failures && vehicle_1.vehicle.vehicle.id === vehicle_2.vehicle.vehicle.id && vehicle_1.vehicle.trip.routeId === vehicle_2.vehicle.trip.routeId && vehicle_1.vehicle.currentStatus === "STOPPED_AT" && vehicle_2.vehicle.currentStatus === "STOPPED_AT") {
				vehicles_stop_duration.push({vehicle: vehicle_1, stop_duration: vehicle_2.vehicle.timestamp - vehicle_1.vehicle.timestamp})
			} else if (vehicle_1.vehicle.vehicle.id === vehicle_2.vehicle.vehicle.id && vehicle_1.vehicle.trip.routeId === vehicle_2.vehicle.trip.routeId && vehicle_1.vehicle.currentStatus === "STOPPED_AT" && vehicle_2.vehicle.currentStatus === "IN_TRANSIT_TO") {
				vehicles_stop_duration.push({vehicle: vehicle_1, stop_duration: vehicle_2.vehicle.timestamp - vehicle_1.vehicle.timestamp})
			}
		}
	}
	return vehicles_stop_duration
}

export async function send_messages(topic, messages) {
  const kafka = new Kafka({
	clientId: "tbm-producer",
	brokers: ["localhost:9092"],
  });

  const producer = kafka.producer({
	createPartitioner: Partitioners.LegacyPartitioner
  });

  try {
	await producer.connect();

	await producer.send({
		topic: topic,
		messages: messages,
	  });
  } finally {
	// Make sure to disconnect the producer, even if an error occurs
	await producer.disconnect();
  }
}

export async function get_actual_vehicle_failures(vehicles_1, vehicles_2){
	let max_stop_duration_before_failure = 300
	let actual_vehicle_failures = []
	await get_vehicles_stop_duration(vehicles_1, vehicles_2, true).then(vehicles_stop_duration => {
		for (const vehicle_stop_duration of vehicles_stop_duration) {
			if (vehicle_stop_duration.stop_duration > max_stop_duration_before_failure) {
				actual_vehicle_failures.push(vehicle_stop_duration.vehicle)
			}
		}
	})
	console.log("Nombre de véhicules en panne : " + actual_vehicle_failures.length)
	return actual_vehicle_failures
}

//create a function that takes all the vehicles and routeid of the vehicles and create a list of the top 5 routes with the most vehicles
export async function get_top_routes(vehicles, top_n_routes = 0){
	let top_routes = []
	let routeid = []
	for (const vehicle of vehicles) {
		routeid.push(vehicle.vehicle.trip.routeId)
	}
	routeid = [...new Set(routeid)]
	for (const route of routeid) {
		let count = 0
		for (const vehicle of vehicles) {
			if (vehicle.vehicle.trip.routeId === route) {
				count++
			}
		}
		
		top_routes.push({route: route, count: count})
	}
	top_routes.sort((a, b) => (a.count < b.count) ? 1 : -1)
	if(top_n_routes > 0){
		top_routes = top_routes.slice(0, top_n_routes)
	}
	//add route_name to the top  routes
	for (const route of top_routes) {
		let route_info = await get_route_info_by_id(route.route)
		route.route_name = route_info.name
	}
	return top_routes
}

export async function get_route_info_by_id(route_id){
	let route_info = await fetch(`https://ws.infotbm.com/ws/1.0/network/line-informations/${route_id}`)
	route_info = await route_info.json()
	return route_info
}

export async function get_stop_info_by_route_id_and_stop_id(route_id, stop_id){
	let route_info = await get_route_info_by_id(route_id)
	let stop_info = route_info.routes[0].stopPoints.find(stopPoint => stopPoint.externalCode == stop_id)
	return stop_info
}

export async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}